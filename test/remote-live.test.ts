import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { RemoteSessions } from '../src/main/claude/remoteLive'
import { WATCH_SCRIPT, WatchParser } from '../src/main/ssh/watch'
import { saveConnection } from '../src/main/store/connections'

/**
 * Issue #26: a remote pane said "remote" and nothing else. One ssh stream per
 * server now brings the server's registry and the tail of its transcripts.
 */

describe('remote watch: parsing the stream (issue #26)', () => {
  it('reads registry snapshots and transcript blocks, whatever the chunking', () => {
    const output = [
      'Welcome to Ubuntu (a login banner is ignored)',
      '@@S',
      '{"pid":10,"sessionId":"aaaa-1","cwd":"/srv/app","status":"busy"}',
      '{"pid":11,"sessionId":"bbbb-2","cwd":"/srv/web","status":"waiting","waitingFor":"Bash"}',
      '{"broken json',
      '{"pid":"not a number","sessionId":"cccc-3"}',
      '@@E',
      '@@T aaaa-1 1',
      '{"type":"assistant","message":{"usage":{"output_tokens":5}}}',
      '@@TE',
      ''
    ].join('\n')

    // Every possible split point: ssh delivers chunks wherever it likes.
    for (let cut = 0; cut <= output.length; cut += 7) {
      const parser = new WatchParser()
      const events = [...parser.feed(output.slice(0, cut)), ...parser.feed(output.slice(cut))]
      assert.equal(events.length, 2, `cut at ${cut}`)
      const [sessions, transcript] = events
      assert.equal(sessions.kind, 'sessions')
      if (sessions.kind === 'sessions') {
        assert.deepEqual(
          sessions.sessions.map((s) => `${s.sessionId}=${s.status}`),
          ['aaaa-1=busy', 'bbbb-2=waiting']
        )
      }
      assert.deepEqual(transcript, {
        kind: 'transcript',
        sessionId: 'aaaa-1',
        reset: true,
        lines: ['{"type":"assistant","message":{"usage":{"output_tokens":5}}}']
      })
    }
  })

  it('accepts CRLF line endings and an empty registry', () => {
    const events = new WatchParser().feed('@@S\r\n@@E\r\n')
    assert.deepEqual(events, [{ kind: 'sessions', sessions: [] }])
  })
})

/**
 * The real script, run by a local sh instead of over ssh, against a fake
 * ~/.claude. Not on Windows: there is no sh there, and on a server there is.
 */
describe('remote watch: the script against a fake server (issue #26)', { skip: process.platform === 'win32' }, () => {
  const SESSION = 'd1d1d1d1-2222-4333-8444-555555555555'

  function fakeServer(): string {
    const home = mkdtempSync(join(tmpdir(), 'cm-remote-'))
    mkdirSync(join(home, 'sessions'))
    // A pid that is alive for the whole test: this test process.
    writeFileSync(
      join(home, 'sessions', `${process.pid}.json`),
      JSON.stringify({ pid: process.pid, sessionId: SESSION, cwd: '/srv/my app', status: 'busy' })
    )
    // A record left behind by a dead process must not show up.
    writeFileSync(
      join(home, 'sessions', '999999999.json'),
      JSON.stringify({ pid: 999999999, sessionId: 'dead-session', cwd: '/srv', status: 'idle' })
    )
    const project = join(home, 'projects', '-srv-my-app')
    mkdirSync(project, { recursive: true })
    writeFileSync(
      join(project, `${SESSION}.jsonl`),
      [
        JSON.stringify({ type: 'user', message: { content: 'hello' } }),
        JSON.stringify({
          type: 'assistant',
          timestamp: '2026-11-20T10:00:00.000Z',
          message: { id: 'm1', model: 'claude-opus-5-5', usage: { input_tokens: 1000, output_tokens: 50_000 } }
        }),
        JSON.stringify({
          type: 'cost-state',
          modelUsage: { 'claude-opus-5-5': { outputTokens: 50_000, costUSD: 1.5 } }
        })
      ].join('\n') + '\n'
    )
    return home
  }

  async function until(check: () => boolean, ms = 10_000): Promise<void> {
    const end = Date.now() + ms
    while (!check()) {
      if (Date.now() > end) throw new Error('timed out')
      await new Promise((r) => setTimeout(r, 100))
    }
  }

  it('brings status, cost and context fill of a remote session, and drops them on release', async () => {
    const home = fakeServer()
    const remote = new RemoteSessions(() =>
      spawn('sh', ['-c', WATCH_SCRIPT], {
        env: { ...process.env, CLAUDE_CONFIG_DIR: home },
        stdio: ['ignore', 'pipe', 'pipe']
      })
    )
    const connection = saveConnection({ name: 'fake', host: 'example.invalid', user: 'me', remotePath: '~' })
    assert.ok(connection)

    remote.retain(connection.id)
    try {
      await until(() => remote.sessions.length > 0 && Boolean(remote.usage()[SESSION]))
      assert.deepEqual(
        remote.sessions.map((s) => `${s.sessionId}=${s.status}`),
        [`${SESSION}=busy`]
      )
      const usage = remote.usage()[SESSION]
      // The server's own figure: the cost-state record, not the table.
      assert.equal(usage.cost, 1.5)
      assert.equal(usage.reportedCost, 1.5)
      assert.equal(usage.contextTokens, 1000)
      assert.equal(usage.contextWindow, 1_000_000)

      // A new turn after the snapshot arrives incrementally, at table price.
      appendFileSync(
        join(home, 'projects', '-srv-my-app', `${SESSION}.jsonl`),
        JSON.stringify({
          type: 'assistant',
          timestamp: '2026-11-20T11:00:00.000Z',
          message: { id: 'm2', model: 'claude-opus-5-5', usage: { input_tokens: 2000, output_tokens: 50_000 } }
        }) + '\n'
      )
      await until(() => remote.usage()[SESSION]?.contextTokens === 2000)
      assert.ok(Math.abs(remote.usage()[SESSION].cost - (1.5 + 0.008 + 1)) < 1e-9)
    } finally {
      remote.release(connection.id)
    }
    assert.deepEqual(remote.sessions, [])
    assert.deepEqual(remote.usage(), {})
  })

  it('a dropped stream clears the sessions instead of freezing them', async () => {
    const home = fakeServer()
    let child: ReturnType<typeof spawn> | null = null
    const remote = new RemoteSessions(() => {
      child = spawn('sh', ['-c', WATCH_SCRIPT], {
        env: { ...process.env, CLAUDE_CONFIG_DIR: home },
        stdio: ['ignore', 'pipe', 'pipe']
      })
      return child
    })
    const connection = saveConnection({ name: 'drop', host: 'example.invalid', user: 'me', remotePath: '~' })
    assert.ok(connection)

    remote.retain(connection.id)
    try {
      await until(() => remote.sessions.length > 0)
      // The network goes away: ssh exits.
      child!.kill()
      await until(() => remote.sessions.length === 0)
    } finally {
      remote.release(connection.id)
    }
  })
})
