import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { changelogEntryFor, draftAction, releasePlan } from '../scripts/release-plan.mjs'
import { signingConfig } from '../scripts/signing.mjs'
import { checkRelease } from '../scripts/verify-release.mjs'

type Facts = Parameters<typeof checkRelease>[0]

/**
 * Issue #17: release 1.1.1 went live attached to `untagged-ad400364ec09c0834247`
 * instead of `v1.1.1`, and nothing complained. `npm run release -- --verify`
 * must fail on exactly that, and on the other ways a published release breaks
 * auto-update without an error anywhere.
 */

const COMMIT = 'ee15ec6e9079ce1b9eae55a6313c5e8973446c92'

function asset(name: string): { name: string } {
  return { name }
}

function release(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'ClaudeManager 1.1.2',
    tag_name: 'v1.1.2',
    draft: false,
    assets: [
      asset('ClaudeManager-Setup-1.1.2.exe'),
      asset('ClaudeManager-Setup-1.1.2.exe.blockmap'),
      asset('ClaudeManager-1.1.2-portable.exe'),
      asset('latest.yml')
    ],
    ...overrides
  }
}

const LATEST_YML = [
  'version: 1.1.2',
  'files:',
  '  - url: ClaudeManager-Setup-1.1.2.exe',
  '    sha512: abc==',
  'path: ClaudeManager-Setup-1.1.2.exe',
  'sha512: abc==',
  "releaseDate: '2026-11-27T10:00:00.000Z'"
].join('\n')

function facts(overrides: Partial<Facts> = {}): Facts {
  return {
    version: '1.1.2',
    releases: [release()],
    remoteTagCommit: COMMIT,
    localTagCommit: COMMIT,
    latestTag: 'v1.1.2',
    latestYml: LATEST_YML,
    installerSha512: 'abc==',
    ...overrides
  }
}

describe('release --verify (issue #17 regression)', () => {
  it('a consistent release passes', () => {
    assert.deepEqual(checkRelease(facts()).problems, [])
  })

  it('fails when the release is attached to a made-up tag, as 1.1.1 was', () => {
    const stray = release({ name: 'ClaudeManager 1.1.1', tag_name: 'untagged-ad400364ec09c0834247' })
    const { problems } = checkRelease(facts({ version: '1.1.1', releases: [stray] }))
    assert.equal(problems.length, 1)
    assert.match(problems[0], /untagged-ad400364ec09c0834247/)
    assert.match(problems[0], /gh release edit untagged-ad400364ec09c0834247 --tag v1\.1\.1/)
  })

  it('fails when two releases share the tag, as the first 1.2.0 workflow run left them', () => {
    // The blockmap alone in one draft, everything else in the other.
    const blockmapOnly = release({
      name: '1.1.2',
      draft: true,
      assets: [asset('ClaudeManager-Setup-1.1.2.exe.blockmap')]
    })
    const rest = release({ draft: true })
    const { problems } = checkRelease(facts({ releases: [blockmapOnly, rest] }))
    assert.ok(problems.some((p) => p.startsWith('2 releases on tag v1.1.2')), problems.join('\n'))
  })

  it('fails when the tag is not on GitHub yet, before the draft is published', () => {
    const { problems } = checkRelease(facts({ remoteTagCommit: null }))
    assert.ok(problems.some((p) => p.includes('git push origin v1.1.2')))
  })

  it('fails when the GitHub tag and the local tag point at different commits', () => {
    const { problems } = checkRelease(facts({ remoteTagCommit: '8815f351db48ba4ebf68b22a7f758b710d9a2218' }))
    assert.ok(problems.some((p) => p.includes('8815f35') && p.includes('ee15ec6')))
  })

  it('fails when latest.yml or the blockmap is missing', () => {
    const noYml = release({ assets: [asset('ClaudeManager-Setup-1.1.2.exe')] })
    const { problems } = checkRelease(facts({ releases: [noYml], latestYml: null }))
    assert.ok(problems.some((p) => p.includes('latest.yml')))
    assert.ok(problems.some((p) => p.includes('.blockmap')))
  })

  it('fails when latest.yml describes another version or another installer', () => {
    const wrong = LATEST_YML.replace('version: 1.1.2', 'version: 1.1.1')
    assert.ok(checkRelease(facts({ latestYml: wrong })).problems.some((p) => p.includes('1.1.1')))
  })

  it('fails when the sha512 in latest.yml does not match the uploaded installer', () => {
    const { problems } = checkRelease(facts({ installerSha512: 'different==' }))
    assert.ok(problems.some((p) => p.includes('sha512')))
  })

  it('a draft is not an error, but it is reported', () => {
    const { problems, notes } = checkRelease(facts({ releases: [release({ draft: true })] }))
    assert.deepEqual(problems, [])
    assert.ok(notes.some((n) => n.includes('draft')))
  })
})

describe('code signing is opt-in (issue #32)', () => {
  const FULL = {
    CM_SIGN_PUBLISHER: 'Example Publisher: "Dev"',
    CM_SIGN_ENDPOINT: 'https://weu.codesigning.azure.net',
    CM_SIGN_ACCOUNT: 'account',
    CM_SIGN_PROFILE: 'profile',
    AZURE_TENANT_ID: 't',
    AZURE_CLIENT_ID: 'c',
    AZURE_CLIENT_SECRET: 's'
  }

  it('nothing configured: an unsigned build, exactly as before', () => {
    assert.equal(signingConfig({}), null)
  })

  it('half configured: the release stops instead of shipping unsigned by surprise', () => {
    assert.throws(() => signingConfig({ CM_SIGN_PUBLISHER: 'x' }), /CM_SIGN_ENDPOINT/)
    const { AZURE_CLIENT_SECRET: _secret, ...noSecret } = FULL
    assert.throws(() => signingConfig(noSecret), /AZURE_CLIENT_SECRET/)
  })

  it('fully configured: extends the base config and quotes every value', () => {
    const yaml = signingConfig(FULL)
    assert.ok(yaml)
    assert.match(yaml, /^extends: electron-builder\.yml$/m)
    // A colon and quotes in the publisher name must not break the YAML.
    assert.ok(yaml.includes('publisherName: "Example Publisher: \\"Dev\\""'))
    assert.ok(yaml.includes('certificateProfileName: "profile"'))
    // The secret stays in the environment, never in the generated file.
    assert.ok(!yaml.includes('AZURE_CLIENT_SECRET') && !yaml.includes(': "s"'))
  })
})

describe('release workflow: the tag and the notes (CI packaging)', () => {
  const CHANGELOG = [
    '# Changelog',
    '',
    '<!-- new versions below -->',
    '',
    '## 1.2.0 — 2026-11-27',
    '',
    'Intro line.',
    '',
    '- **Item.** Text.',
    '',
    '## 1.1.1 — 2026-08-05',
    '',
    '- Old.',
    ''
  ].join('\r\n')

  it('finds a version section, CRLF or not, and only that section', () => {
    const entry = changelogEntryFor(CHANGELOG, '1.2.0')
    assert.ok(entry.startsWith('## 1.2.0 — 2026-11-27'))
    assert.ok(entry.includes('- **Item.** Text.'))
    assert.ok(!entry.includes('1.1.1') && !entry.includes('Old.'))
    // The last section runs to the end of the file.
    assert.equal(changelogEntryFor(CHANGELOG, '1.1.1'), '## 1.1.1 — 2026-08-05\n\n- Old.')
    // "1.2" must not match the 1.2.0 heading.
    assert.equal(changelogEntryFor(CHANGELOG, '1.2'), '')
  })

  it('publishes under the tag package.json names, with the section as notes', () => {
    const plan = releasePlan({ version: '1.2.0', ref: 'v1.2.0', changelog: CHANGELOG })
    assert.equal(plan.tag, 'v1.2.0')
    assert.equal(plan.title, 'ClaudeManager 1.2.0')
    // Earlier releases carry no heading in their notes: the page has a title.
    assert.ok(plan.notes.startsWith('Intro line.'))
    assert.ok(!plan.notes.includes('## '))
  })

  it('refuses a tag that disagrees with package.json, or a run from a branch', () => {
    assert.throws(
      () => releasePlan({ version: '1.2.0', ref: 'v1.2.1', changelog: CHANGELOG }),
      /must run on tag v1\.2\.0/
    )
    assert.throws(() => releasePlan({ version: '1.2.0', ref: 'main', changelog: CHANGELOG }), /v1\.2\.0/)
    assert.throws(() => releasePlan({ version: '1.2.0', ref: '', changelog: CHANGELOG }), /no ref/)
  })

  it('refuses a version without release notes', () => {
    assert.throws(
      () => releasePlan({ version: '1.3.0', ref: 'v1.3.0', changelog: CHANGELOG }),
      /no "## 1\.3\.0 " section/
    )
  })
})

describe('release workflow: one draft per tag (1.2.0 got two)', () => {
  const draft = { tag_name: 'v1.2.0', draft: true }

  it('creates the draft when the tag has none, and reuses a single one', () => {
    assert.equal(draftAction([], 'v1.2.0'), 'create')
    assert.equal(draftAction([{ tag_name: 'v1.1.1', draft: false }], 'v1.2.0'), 'create')
    assert.equal(draftAction([draft], 'v1.2.0'), 'update')
  })

  it('never uploads over a published release', () => {
    assert.throws(() => draftAction([{ tag_name: 'v1.2.0', draft: false }], 'v1.2.0'), /already published/)
  })

  it('stops on duplicate drafts instead of picking one', () => {
    assert.throws(() => draftAction([draft, draft], 'v1.2.0'), /2 draft releases on v1\.2\.0/)
  })
})
