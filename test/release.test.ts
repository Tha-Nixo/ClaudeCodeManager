import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
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
