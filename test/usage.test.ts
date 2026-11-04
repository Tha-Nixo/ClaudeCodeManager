import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { contextWindowFor, costOf, priceFor } from '../src/main/usage/pricing'
import { scan, sessionUsage, summarize } from '../src/main/usage/scanner'

/**
 * Token accounting: prices, context windows, and transcript parsing.
 *
 * `projectsDir()` uses `CLAUDE_CONFIG_DIR`, so the scanner runs against
 * an isolated temporary directory. No test touches ~/.claude on the host.
 */

// --- Test Fixtures ----------------------------------------------------------

function fakeRoot(): string {
  const home = mkdtempSync(join(tmpdir(), 'cm-usage-'))
  const project = join(home, 'projects', 'C--fake-project')
  mkdirSync(project, { recursive: true })
  process.env.CLAUDE_CONFIG_DIR = home
  return project
}

interface UsageData {
  input?: number
  output?: number
  cacheRead?: number
  cacheWrite5m?: number
  cacheWrite1h?: number
}

/** Formats a JSONL transcript line matching Claude Code structure. */
function makeRow(opts: {
  id?: string
  model?: string
  type?: string
  cwd?: string
  at?: Date | number
  uso?: UsageData
}): string {
  const u = opts.uso ?? {}
  const rec: Record<string, unknown> = {
    type: opts.type ?? 'assistant',
    cwd: opts.cwd ?? 'C:\\fake\\project',
    message: {
      id: opts.id,
      model: opts.model ?? 'claude-opus-5',
      usage: {
        input_tokens: u.input ?? 0,
        output_tokens: u.output ?? 0,
        cache_read_input_tokens: u.cacheRead ?? 0,
        cache_creation: {
          ephemeral_5m_input_tokens: u.cacheWrite5m ?? 0,
          ephemeral_1h_input_tokens: u.cacheWrite1h ?? 0
        }
      }
    }
  }
  if (opts.at !== undefined) rec.timestamp = new Date(opts.at).toISOString()
  return JSON.stringify(rec)
}

function writeTranscript(dir: string, name: string, lines: string[]): string {
  const file = join(dir, `${name}.jsonl`)
  writeFileSync(file, `${lines.join('\n')}\n`, 'utf8')
  return file
}

function rescan(): void {
  scan(true)
}

// --- Pricing & Context Windows ----------------------------------------------

describe('pricing: context window (issue #11 regression)', () => {
  it('recognizes id with date suffix without marking it approximate', () => {
    assert.deepEqual(contextWindowFor('claude-haiku-4-5-20251001'), {
      window: 200_000,
      approximate: false
    })
    assert.deepEqual(contextWindowFor('claude-sonnet-4-6-20260101'), {
      window: 1_000_000,
      approximate: false
    })
  })

  it('Opus 5 has an exact 1M token window', () => {
    assert.deepEqual(contextWindowFor('claude-opus-5'), { window: 1_000_000, approximate: false })
    assert.deepEqual(contextWindowFor('claude-opus-5-20260315'), {
      window: 1_000_000,
      approximate: false
    })
  })

  it('Haiku remains 200K without inheriting 1M from other models', () => {
    assert.equal(contextWindowFor('claude-haiku-4-5').window, 200_000)
  })

  it('unknown model does not produce fabricated percentage', () => {
    assert.deepEqual(contextWindowFor('gpt-5-turbo'), { window: 0, approximate: false })
    assert.deepEqual(contextWindowFor(null), { window: 0, approximate: false })
    assert.deepEqual(contextWindowFor(undefined), { window: 0, approximate: false })
    assert.deepEqual(contextWindowFor(''), { window: 0, approximate: false })
  })

  it('marks approximate for future models matched by family heuristic', () => {
    assert.deepEqual(contextWindowFor('claude-haiku-9-0-20270101'), {
      window: 200_000,
      approximate: true
    })
    assert.equal(contextWindowFor('claude-opus-42').approximate, true)
  })

  it('case insensitive matching', () => {
    assert.deepEqual(contextWindowFor('CLAUDE-HAIKU-4-5-20251001'), {
      window: 200_000,
      approximate: false
    })
  })
})

describe('pricing: token cost computation', () => {
  const onlyInput = (n: number): Parameters<typeof costOf>[1] => ({
    input: n,
    output: 0,
    cacheRead: 0,
    cacheWrite5m: 0,
    cacheWrite1h: 0
  })

  it('applies model rate including date suffix', () => {
    const cost = costOf('claude-haiku-4-5-20251001', {
      input: 1_000_000,
      output: 1_000_000,
      cacheRead: 0,
      cacheWrite5m: 0,
      cacheWrite1h: 0
    })
    assert.equal(cost, 6)
  })

  it('cache read costs less and cache write costs more', () => {
    const base = costOf('claude-opus-5', onlyInput(1_000_000))
    assert.equal(base, 5)
    assert.equal(
      costOf('claude-opus-5', {
        input: 0,
        output: 0,
        cacheRead: 1_000_000,
        cacheWrite5m: 0,
        cacheWrite1h: 0
      }),
      0.5
    )
    assert.equal(
      costOf('claude-opus-5', {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite5m: 1_000_000,
        cacheWrite1h: 0
      }),
      6.25
    )
    assert.equal(
      costOf('claude-opus-5', {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite5m: 0,
        cacheWrite1h: 1_000_000
      }),
      10
    )
  })

  it('unknown model costs zero', () => {
    assert.equal(costOf('gpt-5-turbo', onlyInput(1_000_000)), 0)
    assert.equal(costOf(null, onlyInput(1_000_000)), 0)
    assert.equal(priceFor('gpt-5-turbo'), null)
  })

  it('large numbers remain finite without NaN or Infinity', () => {
    const huge = {
      input: 1e15,
      output: 1e15,
      cacheRead: 1e15,
      cacheWrite5m: 1e15,
      cacheWrite1h: 1e15
    }
    const cost = costOf('claude-opus-5', huge)
    assert.ok(Number.isFinite(cost), `non-finite cost: ${cost}`)
    assert.ok(cost > 0)
    assert.ok(cost > 4.6e10 && cost < 4.8e10, `unexpected magnitude: ${cost}`)

    const doubleCost = costOf('claude-opus-5', {
      input: 2e15,
      output: 2e15,
      cacheRead: 2e15,
      cacheWrite5m: 2e15,
      cacheWrite1h: 2e15
    })
    assert.ok(Number.isFinite(doubleCost))
    assert.ok(doubleCost > cost)
  })
})

// --- Transcript Parsing -----------------------------------------------------

describe('scanner: core parser logic', () => {
  it('deduplicates lines sharing message.id using latest values', () => {
    const project = fakeRoot()
    writeTranscript(project, 'dedup-session', [
      makeRow({ id: 'msg_A', uso: { output: 100 }, at: '2026-01-15T10:00:00.000Z' }),
      makeRow({ id: 'msg_A', uso: { output: 500 }, at: '2026-01-15T10:00:03.000Z' })
    ])

    rescan()
    const totals = summarize()
    assert.equal(totals.totalTokens, 500)
    assert.equal(totals.sessions, 1)
    assert.equal(sessionUsage()['dedup-session'].turns, 1)
  })

  it('preserves distinct turns when message.id is absent', () => {
    const project = fakeRoot()
    writeTranscript(project, 'anonymous-session', [
      makeRow({ uso: { output: 100 } }),
      makeRow({ uso: { output: 500 } })
    ])

    rescan()
    assert.equal(summarize().totalTokens, 600)
    assert.equal(sessionUsage()['anonymous-session'].turns, 2)
  })

  it('malformed line does not drop the rest of the file', () => {
    const project = fakeRoot()
    writeTranscript(project, 'broken-session', [
      makeRow({ id: 'm1', uso: { output: 10 } }),
      '{"type":"assistant","message":{"id":"m2","usage":{"output_toke',
      'this line is not json, but contains "usage"',
      '{"type":"assistant","usage":{"output_tokens":9999}}',
      '{}',
      '',
      '   ',
      makeRow({ id: 'm3', uso: { output: 7 } })
    ])

    rescan()
    const totals = summarize()
    assert.equal(totals.totalTokens, 17)
    assert.equal(totals.sessions, 1)
    assert.equal(sessionUsage()['broken-session'].turns, 2)
  })

  it('counts only assistant records', () => {
    const project = fakeRoot()
    writeTranscript(project, 'types-session', [
      makeRow({ id: 'u1', type: 'user', uso: { output: 9000 } }),
      makeRow({ id: 's1', type: 'summary', uso: { output: 9000 } }),
      makeRow({ id: 'a1', uso: { output: 42 } })
    ])

    rescan()
    assert.equal(summarize().totalTokens, 42)
    assert.equal(sessionUsage()['types-session'].turns, 1)
  })

  it('discards zero-token turns and synthetic models', () => {
    const project = fakeRoot()
    writeTranscript(project, 'empty-session', [
      makeRow({ id: 'z1', uso: {} }),
      makeRow({ id: 'z2', model: '<synthetic>', uso: { output: 5000 } })
    ])

    rescan()
    const totals = summarize()
    assert.equal(totals.totalTokens, 0)
    assert.equal(totals.sessions, 0)
    assert.equal(sessionUsage()['empty-session'].turns, 0)
  })

  it('legacy cache write without 5m/1h breakdown defaults to 5m', () => {
    const project = fakeRoot()
    writeTranscript(project, 'cache-session', [
      JSON.stringify({
        type: 'assistant',
        cwd: 'C:\\fake\\project',
        message: {
          id: 'c1',
          model: 'claude-opus-5',
          usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 1_000_000 }
        }
      })
    ])

    rescan()
    const totals = summarize()
    assert.equal(totals.totalTokens, 1_000_000)
    assert.equal(totals.totalCost, 6.25)
  })

  it('aggregates by model and by project folder', () => {
    const project = fakeRoot()
    writeTranscript(project, 'session-one', [
      makeRow({ id: 'a', cwd: 'C:\\work\\alpha', uso: { output: 1000 } })
    ])
    writeTranscript(project, 'session-two', [
      makeRow({ id: 'b', cwd: 'C:\\work\\alpha', model: 'claude-haiku-4-5-20251001', uso: { output: 2000 } })
    ])

    rescan()
    const totals = summarize()
    assert.equal(totals.sessions, 2)
    assert.equal(totals.byProject.length, 1)
    assert.equal(totals.byProject[0].path, 'C:\\work\\alpha')
    assert.equal(totals.byProject[0].tokens, 3000)

    assert.equal(totals.byModel.length, 2)
    assert.equal(totals.byModel[0].model, 'claude-opus-5')
    assert.equal(totals.byModel[0].tokens, 1000)
    assert.equal(totals.byModel[1].tokens, 2000)
  })
})

describe('scanner: session context tracking', () => {
  it('lastContext reflects the latest turn, not maximum or sum', () => {
    const project = fakeRoot()
    writeTranscript(project, 'context-session', [
      makeRow({ id: 't1', uso: { input: 100, cacheRead: 900, output: 50 } }),
      makeRow({ id: 't2', uso: { input: 200, cacheRead: 49_800, output: 60 } }),
      makeRow({ id: 't3', uso: { input: 50, cacheRead: 250, output: 70 } })
    ])

    rescan()
    const session = sessionUsage()['context-session']
    assert.equal(session.contextTokens, 300)
    assert.notEqual(session.contextTokens, 50_000)
    assert.notEqual(session.contextTokens, 51_300)
    assert.equal(session.turns, 3)
    assert.equal(session.tokens, 51_480)
  })

  it('context window tracks model of latest turn (issue #11)', () => {
    const project = fakeRoot()
    writeTranscript(project, 'haiku-session', [
      makeRow({ id: 'h1', model: 'claude-opus-5', uso: { input: 1000 } }),
      makeRow({ id: 'h2', model: 'claude-haiku-4-5-20251001', uso: { input: 2000 } })
    ])

    rescan()
    const session = sessionUsage()['haiku-session']
    assert.equal(session.model, 'claude-haiku-4-5-20251001')
    assert.equal(session.contextWindow, 200_000)
    assert.equal(session.contextApproximate, false)
  })

  it('deleted transcript is removed from totals', () => {
    const project = fakeRoot()
    writeTranscript(project, 'session-remaining', [makeRow({ id: 'r1', uso: { output: 1000 } })])
    const toDelete = writeTranscript(project, 'session-to-delete', [
      makeRow({ id: 'x1', uso: { output: 2000 } })
    ])

    rescan()
    assert.equal(summarize().totalTokens, 3000)
    assert.equal(summarize().sessions, 2)

    rmSync(toDelete)
    rescan()

    const after = summarize()
    assert.equal(after.totalTokens, 1000)
    assert.equal(after.sessions, 1)
    assert.equal(sessionUsage()['session-to-delete'], undefined)
    assert.ok(sessionUsage()['session-remaining'])
  })

  it('reads transcripts from subagent subfolders', () => {
    const project = fakeRoot()
    const subagents = join(project, 'subagents')
    mkdirSync(subagents, { recursive: true })
    writeTranscript(project, 'main-session', [makeRow({ id: 'p1', uso: { output: 100 } })])
    writeTranscript(subagents, 'subagent-session', [makeRow({ id: 'a1', uso: { output: 400 } })])

    rescan()
    assert.equal(summarize().totalTokens, 500)
    assert.equal(summarize().sessions, 2)
  })
})

// --- Local Day Accounting ---------------------------------------------------

describe('scanner: local day tracking (issue #3 regression)', () => {
  it('assigns today turn to today even when UTC is a different calendar day', () => {
    const now = new Date()
    const isEast = -now.getTimezoneOffset() > 0
    const instant = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
      isEast ? 0 : 23,
      30
    )

    const localKey = [
      instant.getFullYear(),
      String(instant.getMonth() + 1).padStart(2, '0'),
      String(instant.getDate()).padStart(2, '0')
    ].join('-')

    if (now.getTimezoneOffset() !== 0) {
      assert.notEqual(
        instant.toISOString().slice(0, 10),
        localKey,
        'test must cross UTC midnight'
      )
    }

    const threeDaysAgo = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 3, 12)
    const tenDaysAgo = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() - 10,
      12
    )

    const project = fakeRoot()
    writeTranscript(project, 'days-session', [
      makeRow({ id: 'g1', uso: { output: 1000 }, at: instant }),
      makeRow({ id: 'g2', uso: { output: 200 }, at: threeDaysAgo }),
      makeRow({ id: 'g3', uso: { output: 30 }, at: tenDaysAgo })
    ])

    rescan()
    const totals = summarize()

    assert.equal(totals.todayTokens, 1000)
    assert.equal(totals.weekTokens, 1200)
    assert.equal(totals.totalTokens, 1230)
    assert.equal(totals.todayCost, 0.025)
    assert.ok(totals.weekCost > totals.todayCost)
    assert.ok(totals.totalCost > totals.weekCost)
  })

  it('yesterday evening turn is not counted in today', () => {
    const now = new Date()
    const yesterdayEvening = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() - 1,
      23,
      30
    )

    const project = fakeRoot()
    writeTranscript(project, 'yesterday-session', [
      makeRow({ id: 'i1', uso: { output: 500 }, at: yesterdayEvening })
    ])

    rescan()
    const totals = summarize()
    assert.equal(totals.todayTokens, 0)
    assert.equal(totals.todayCost, 0)
    assert.equal(totals.weekTokens, 500)
    assert.equal(totals.totalTokens, 500)
  })

  it('turn missing timestamp remains in grand total but excluded from today', () => {
    const project = fakeRoot()
    writeTranscript(project, 'dateless-session', [makeRow({ id: 'n1', uso: { output: 800 } })])

    rescan()
    const totals = summarize()
    assert.equal(totals.totalTokens, 800)
    assert.equal(totals.todayTokens, 0)
    assert.equal(totals.weekTokens, 0)
    assert.equal(sessionUsage()['dateless-session'].lastAt, 0)
  })
})
