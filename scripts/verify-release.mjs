import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Post-publish check of a GitHub release (#17).
 *
 * Release 1.1.1 went live attached to an auto-generated tag,
 * `untagged-ad400364ec09c0834247`, pointing at a commit three months newer than
 * the release, instead of `v1.1.1`. Nothing complained: auto-update happened to
 * keep working, and the source archives on the release page held the wrong
 * code. The release script uploads a draft before the tag exists on GitHub, so
 * the tag is attached by hand when the draft is published, and a skipped step
 * leaves no trace. This check turns that step into something that fails loudly.
 *
 *   npm run release -- --verify            the version in package.json
 *   npm run release -- --verify 1.1.0      any other version
 *
 * GH_TOKEN is optional for a published release and required to see a draft.
 */

const REPO = 'Tha-Nixo/ClaudeCodeManager'
const API = `https://api.github.com/repos/${REPO}`

/**
 * The pure part of the check: everything it needs is passed in, so it can be
 * tested without the network.
 *
 * @param {object} facts
 * @param {string} facts.version          e.g. '1.1.2'
 * @param {object[]} facts.releases       GitHub release objects
 * @param {string | null} facts.remoteTagCommit  commit the GitHub tag points at
 * @param {string | null} facts.localTagCommit   commit the local tag points at
 * @param {string | null} facts.latestTag  tag_name of /releases/latest
 * @param {string | null} facts.latestYml  contents of the release's latest.yml
 * @param {string | null} facts.installerSha512  base64 sha512 of the uploaded installer
 * @returns {{ problems: string[], notes: string[] }}
 */
export function checkRelease(facts) {
  const { version, releases } = facts
  const tag = `v${version}`
  const problems = []
  const notes = []

  // A release whose name says this version but whose tag is something else is
  // exactly the 1.1.1 case: look for it first, by name, not by tag.
  const named = releases.filter((r) => (r.name ?? '').split(/\s+/).includes(version))
  for (const r of named) {
    if (r.tag_name !== tag) {
      problems.push(
        `release "${r.name}" is attached to tag "${r.tag_name}", not "${tag}". ` +
          `Fix: gh release edit ${r.tag_name} --tag ${tag}`
      )
    }
  }

  // Two releases on one tag (1.2.0's first workflow run made two drafts): the
  // checks below would read one of them, and the assets could be in the other.
  const onTag = releases.filter((r) => r.tag_name === tag)
  if (onTag.length > 1) {
    problems.push(
      `${onTag.length} releases on tag ${tag} (${onTag.map((r) => `"${r.name}"`).join(', ')}): ` +
        'keep one, with all the assets'
    )
  }

  const release = onTag[0]
  if (!release) {
    if (named.length === 0) problems.push(`no release found for ${tag}`)
    return { problems, notes }
  }

  if (!facts.remoteTagCommit) {
    problems.push(
      `tag ${tag} does not exist on GitHub. Push it before publishing the draft: ` +
        `git push origin ${tag}. Publishing without it makes GitHub create the tag ` +
        `on whatever main points at.`
    )
  } else if (facts.localTagCommit && facts.remoteTagCommit !== facts.localTagCommit) {
    problems.push(
      `tag ${tag} points at ${facts.remoteTagCommit.slice(0, 7)} on GitHub but at ` +
        `${facts.localTagCommit.slice(0, 7)} locally`
    )
  }

  const assets = (release.assets ?? []).map((a) => a.name)
  const installer = assets.find((n) => n.endsWith('.exe') && n.includes('Setup'))
  for (const required of ['latest.yml', installer, installer && `${installer}.blockmap`]) {
    if (!required) {
      problems.push('no installer (*Setup*.exe) among the release assets')
    } else if (!assets.includes(required)) {
      problems.push(`asset ${required} is missing: auto-update needs it`)
    }
  }

  if (facts.latestYml) {
    const ymlVersion = (facts.latestYml.match(/^version:\s*(.+)$/m) ?? [])[1]?.trim()
    const ymlPath = (facts.latestYml.match(/^path:\s*(.+)$/m) ?? [])[1]?.trim()
    const ymlSha = (facts.latestYml.match(/^sha512:\s*(.+)$/m) ?? [])[1]?.trim()
    if (ymlVersion !== version) {
      problems.push(`latest.yml says version ${ymlVersion ?? '(none)'}, not ${version}`)
    }
    if (installer && ymlPath && ymlPath !== installer) {
      problems.push(`latest.yml points at ${ymlPath}, but the installer asset is ${installer}`)
    }
    if (facts.installerSha512 && ymlSha && facts.installerSha512 !== ymlSha) {
      problems.push(
        'the sha512 in latest.yml does not match the uploaded installer: ' +
          'electron-updater would download the update and then discard it'
      )
    }
    if (!facts.installerSha512) notes.push('installer sha512 not compared (installer not available)')
  }

  if (release.draft) {
    notes.push(`${tag} is still a draft: no installed copy sees it until it is published`)
  } else if (facts.latestTag !== null && facts.latestTag !== undefined) {
    // electron-updater asks /releases/latest which tag to read latest.yml from.
    if (facts.latestTag !== tag) {
      notes.push(`/releases/latest is ${facts.latestTag}: installed copies are offered that one`)
    }
  }

  return { problems, notes }
}

async function getJson(url, headers) {
  const res = await fetch(url, { headers })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`)
  return res.json()
}

/** Commit a GitHub tag points at, following annotated tags. */
async function remoteTagCommit(tag, headers) {
  const ref = await getJson(`${API}/git/ref/tags/${encodeURIComponent(tag)}`, headers)
  if (!ref) return null
  if (ref.object.type === 'commit') return ref.object.sha
  const annotated = await getJson(`${API}/git/tags/${ref.object.sha}`, headers)
  return annotated?.object?.sha ?? null
}

/** Asset contents: through the API, so that drafts work with a token too. */
async function download(asset, headers) {
  const res = await fetch(asset.url, { headers: { ...headers, Accept: 'application/octet-stream' } })
  if (!res.ok) throw new Error(`${asset.name}: HTTP ${res.status}`)
  return res
}

async function sha512OfAsset(asset, headers) {
  const hash = createHash('sha512')
  const res = await download(asset, headers)
  for await (const chunk of res.body) hash.update(chunk)
  return hash.digest('base64')
}

/**
 * Gathers the facts from GitHub and git, runs checkRelease, prints the result.
 * Returns the process exit code.
 */
export async function verifyRelease({ version, root, git }) {
  const tag = `v${version}`
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'claudemanager-release-check' }
  if (process.env.GH_TOKEN) headers.Authorization = `Bearer ${process.env.GH_TOKEN}`

  let localTagCommit = null
  try {
    localTagCommit = git('rev-parse', `${tag}^{commit}`)
  } catch {
    // No local tag (a fresh clone, or an old version): compare with GitHub only.
  }

  const releases = (await getJson(`${API}/releases?per_page=50`, headers)) ?? []
  const release = releases.find((r) => r.tag_name === tag)
  const latest = await getJson(`${API}/releases/latest`, headers)

  let latestYml = null
  let installerSha512 = null
  if (release) {
    const ymlAsset = release.assets.find((a) => a.name === 'latest.yml')
    if (ymlAsset) latestYml = await (await download(ymlAsset, headers)).text()

    const installer = release.assets.find((a) => a.name.endsWith('.exe') && a.name.includes('Setup'))
    const local = installer && join(root, 'release', tag, installer.name)
    if (local && existsSync(local)) {
      // The local copy is the one that was uploaded, if its size matches.
      const bytes = readFileSync(local)
      if (bytes.length === installer.size) {
        installerSha512 = createHash('sha512').update(bytes).digest('base64')
      }
    }
    if (installer && !installerSha512) installerSha512 = await sha512OfAsset(installer, headers)
  }

  const { problems, notes } = checkRelease({
    version,
    releases,
    remoteTagCommit: await remoteTagCommit(tag, headers),
    localTagCommit,
    latestTag: latest?.tag_name ?? null,
    latestYml,
    installerSha512
  })

  console.log(`\nRelease ${tag} on github.com/${REPO}`)
  for (const n of notes) console.log(`  note: ${n}`)
  if (problems.length === 0) {
    console.log('  OK: tag, assets and latest.yml are consistent')
    return 0
  }
  for (const p of problems) console.log(`  PROBLEM: ${p}`)
  return 1
}
