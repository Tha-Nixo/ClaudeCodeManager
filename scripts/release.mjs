#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Prepares a release: bumps version, writes changelog from commits,
 * builds packages, and tags the git commit.
 *
 *   npm run release -- patch|minor|major|<version>
 *   npm run release -- minor --dry      dry run: preview without writing
 *
 * Publishing to GitHub requires GH_TOKEN in the environment, and the release
 * is created as a DRAFT: it must be reviewed and published manually. An auto-update
 * reaches all active installations, so making it live must be an intentional
 * decision, not a side-effect of running a script.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const dryRun = args.includes('--dry')
const bump = args.find((a) => !a.startsWith('--')) ?? 'patch'

function git(...params) {
  return execFileSync('git', params, { cwd: root, encoding: 'utf8' }).trim()
}

/**
 * Executes a command while printing it.
 *
 * `shell` is only needed for npm and npx on Windows (.cmd wrappers).
 * It is enabled only when strictly necessary to prevent argument mangling.
 */
function run(command, params, needsShell = false) {
  console.log(`  $ ${command} ${params.join(' ')}`)
  if (dryRun) return
  execFileSync(command, params, { cwd: root, stdio: 'inherit', shell: needsShell })
}

function nextVersion(current, kind) {
  if (/^\d+\.\d+\.\d+$/.test(kind)) return kind
  const [major, minor, patch] = current.split('.').map(Number)
  if (kind === 'major') return `${major + 1}.0.0`
  if (kind === 'minor') return `${major}.${minor + 1}.0`
  if (kind === 'patch') return `${major}.${minor}.${patch + 1}`
  throw new Error(`Unrecognized increment: ${kind}`)
}

/**
 * Changelog entries extracted from commits since last tag.
 *
 * Uses only the first line of each commit message.
 */
function changesSinceLastTag() {
  let range = ''
  try {
    range = `${git('describe', '--tags', '--abbrev=0')}..HEAD`
  } catch {
    // No tags yet: take whole commit history.
  }

  const log = git('log', '--no-merges', '--format=%s', ...(range ? [range] : []))
  return log
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => `- ${line}`)
}

/** Changelog section for a given version to reuse as release notes. */
function changelogEntryFor(version) {
  const md = readFileSync(join(root, 'CHANGELOG.md'), 'utf8')
  const lines = md.split('\n')
  const start = lines.findIndex((l) => l.startsWith(`## ${version} `))
  if (start === -1) return ''
  const rest = lines.slice(start + 1)
  const end = rest.findIndex((l) => l.startsWith('## '))
  return [lines[start], ...(end === -1 ? rest : rest.slice(0, end))].join('\n').trim()
}

// Reorganize release folder without modifying version or tags:
// useful after a manual `npm run dist` or to regenerate upload instructions.
if (args.includes('--tidy')) {
  const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
  const result = reorganize(join(root, 'release', `v${version}`), version, changelogEntryFor(version))
  if (!result) {
    console.error(`No folder release/v${version}: build packages first.`)
    process.exit(1)
  }
  console.log(`release/v${version} — ${result.status}`)
  for (const f of result.toPublish) console.log(`  ${f}`)
  console.log(`  (instructions: release/v${version}/TO-UPLOAD.md)`)
  process.exit(0)
}

// --- Pre-flight checks -------------------------------------------------------

const status = git('status', '--porcelain')
if (status && !dryRun) {
  console.error('Working directory has uncommitted changes. Please commit or stash before releasing:\n' + status)
  process.exit(1)
}

const pkgPath = join(root, 'package.json')
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
const version = nextVersion(pkg.version, bump)
const tag = `v${version}`

const existing = git('tag', '--list', tag)
if (existing) {
  console.error(`Tag ${tag} already exists.`)
  process.exit(1)
}

console.log(`\n${pkg.version} → ${version}${dryRun ? '  (dry run)' : ''}\n`)

// --- Changelog ---------------------------------------------------------------

const changes = changesSinceLastTag()
if (changes.length === 0) {
  console.error('No commits since last tag: nothing to release.')
  process.exit(1)
}

const today = new Date().toISOString().slice(0, 10)
const entry = `## ${version} — ${today}\n\n${changes.join('\n')}\n`

const changelogPath = join(root, 'CHANGELOG.md')
const changelog = readFileSync(changelogPath, 'utf8')
// New entry goes right below the header marker.
const marker = '<!-- new versions below -->'
const updated = changelog.includes(marker)
  ? changelog.replace(`${marker}\n`, `${marker}\n\n${entry}`)
  : `${changelog}\n${entry}`

console.log(entry)

if (!dryRun) {
  pkg.version = version
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8')
  writeFileSync(changelogPath, updated, 'utf8')
}

/**
 * Reorganizes the newly built release directory.
 *
 * electron-builder outputs both publishable artifacts and intermediate files
 * (such as 300MB win-unpacked and logs) into the same output directory.
 * Intermediate files are moved to `intermediate/` so only uploadable files remain.
 */

/** File names and extensions intended for public release. */
function isPublishable(name) {
  return name.endsWith('.exe') || name.endsWith('.blockmap') || name === 'latest.yml'
}

function sha512Base64(file) {
  return createHash('sha512').update(readFileSync(file)).digest('base64')
}

function reorganize(outDir, version, entry) {
  if (!existsSync(outDir)) return null

  const intermediate = join(outDir, 'intermediate')
  const toPublish = []

  for (const name of readdirSync(outDir)) {
    if (name === 'intermediate' || name === 'intermedi' || name === 'TO-UPLOAD.md' || name === 'DA-CARICARE.md') continue
    if (isPublishable(name)) {
      toPublish.push(name)
      continue
    }
    mkdirSync(intermediate, { recursive: true })
    try {
      renameSync(join(outDir, name), join(intermediate, name))
    } catch {
      // File currently in use (e.g. running portable exe) stays in place.
    }
  }

  toPublish.sort()

  // Guard against broken auto-updates: if sha512 inside latest.yml does not match installer,
  // electron-updater silently discards the downloaded update.
  let status = 'latest.yml missing'
  const latest = join(outDir, 'latest.yml')
  if (existsSync(latest)) {
    const expected = (readFileSync(latest, 'utf8').match(/^sha512: (.+)$/m) ?? [])[1]?.trim()
    const installer = toPublish.find((f) => f.includes('Setup'))
    if (expected && installer) {
      const actual = sha512Base64(join(outDir, installer))
      status = expected === actual ? 'sha512 matches installer' : '⚠ SHA512 MISMATCH'
    }
  }

  const list = toPublish.map((f) => `- \`${f}\``).join('\n')
  writeFileSync(
    join(outDir, 'TO-UPLOAD.md'),
    `# Release ${version}

On https://github.com/Tha-Nixo/ClaudeCodeManager/releases/new:

1. Under *Choose a tag*, select **\`v${version}\`** (already created).
2. Title: \`ClaudeManager ${version}\`
3. Description: paste the text below.
4. Drag and drop these files (all and only files in this directory):

${list}

   \`latest.yml\` is required: auto-updates will not function without it.
   The \`.blockmap\` file enables delta downloads for subsequent updates.

5. Click **Publish release**.

Verification check: ${status}

The \`intermediate/\` subfolder should not be uploaded.

---

${entry}`,
    'utf8'
  )

  return { outDir, toPublish, status }
}

// --- Build and tag -----------------------------------------------------------

const publish = process.env.GH_TOKEN ? 'always' : 'never'
if (publish === 'never') {
  console.log('\nGH_TOKEN not set: packages built locally without uploading to GitHub.\n')
}

run('npm', ['run', 'typecheck'], true)
run('npx', ['electron-vite', 'build'], true)
run('npx', ['electron-builder', '--publish', publish], true)

// Matches directories.output in electron-builder.yml.
const outDir = join(root, 'release', tag)
const reorganized = dryRun ? null : reorganize(outDir, version, entry)

// git starts directly: no shell, so no hand-written quotes.
run('git', ['add', 'package.json', 'CHANGELOG.md'])
run('git', ['commit', '-m', tag])
run('git', ['tag', '-a', tag, '-m', tag])

if (reorganized) {
  console.log(`\nArtifacts in release/${tag}/ — ${reorganized.status}`)
  for (const f of reorganized.toPublish) console.log(`  ${f}`)
  console.log(`  (release instructions: release/${tag}/TO-UPLOAD.md)`)
}

console.log(`\nDone. Remaining manual steps:`)
console.log(`  git push && git push origin ${tag}`)
if (publish === 'always') {
  console.log('  publish draft release on GitHub (no clients receive it while in draft)')
} else {
  console.log(`  upload files from release/${tag}/ to GitHub release`)
}
