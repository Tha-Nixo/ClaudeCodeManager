import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { contextWindowFor, costOf, priceFor, type TokenCounts } from '../src/main/usage/pricing'
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

  it("Haiku 5.5 has a 1M window, not Haiku 4.5's 200K (issue #16)", () => {
    assert.deepEqual(contextWindowFor('claude-haiku-5-5'), {
      window: 1_000_000,
      approximate: false
    })
  })

  it('unknown model does not produce fabricated percentage', () => {
    assert.deepEqual(contextWindowFor('gpt-5-turbo'), { window: 0, approximate: false })
    assert.deepEqual(contextWindowFor(null), { window: 0, approximate: false })
    assert.deepEqual(contextWindowFor(undefined), { window: 0, approximate: false })
    assert.deepEqual(contextWindowFor(''), { window: 0, approximate: false })
  })

  it('marks approximate for future models matched by family heuristic', () => {
    // Unknown Haiku ids fall back to the newest Haiku (5.5, 1M), flagged as a guess.
    assert.deepEqual(contextWindowFor('claude-haiku-9-0-20270101'), {
      window: 1_000_000,
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

/**
 * Issue #16: every model released after August 2026 was priced as its
 * predecessor (prefix match) and labelled exact, and cache reads were a fixed
 * 0.1x of input. The entries below are `cost-state` records that Claude Code
 * 2.1.322+ wrote into real transcripts: `costUSD` is what `/cost` showed. The
 * price table must reproduce it from the token counts.
 */
const COST_STATE: { model: string; usage: Record<string, number>; costUSD: number }[] = [
  {
    model: 'claude-fable-5-2',
    usage: {
      inputTokens: 5762,
      outputTokens: 550445,
      cacheReadInputTokens: 186566622,
      cacheCreationEphemeral5mInputTokens: 1194,
      cacheCreationEphemeral1hInputTokens: 5805677
    },
    costUSD: 152.2799924
  },
  {
    model: 'claude-opus-5-5',
    usage: {
      inputTokens: 2775,
      outputTokens: 145956,
      cacheReadInputTokens: 29857691,
      cacheCreationEphemeral5mInputTokens: 207,
      cacheCreationEphemeral1hInputTokens: 399756
    },
    costUSD: 12.1008412
  },
  {
    model: 'claude-sonnet-5-5',
    usage: {
      inputTokens: 11908,
      outputTokens: 3688821,
      cacheReadInputTokens: 960773763,
      cacheCreationEphemeral5mInputTokens: 14255010,
      cacheCreationEphemeral1hInputTokens: 5591703
    },
    costUSD: 190.9937393
  },
  {
    // A session whose every request stayed under 100K prompt tokens: base tier.
    model: 'claude-haiku-5-5',
    usage: {
      inputTokens: 52630,
      outputTokens: 16,
      cacheReadInputTokens: 0,
      cacheCreationEphemeral5mInputTokens: 0,
      cacheCreationEphemeral1hInputTokens: 0
    },
    costUSD: 0.005271
  },
  {
    model: 'claude-opus-5',
    usage: {
      inputTokens: 4,
      outputTokens: 0,
      cacheReadInputTokens: 42360,
      cacheCreationEphemeral5mInputTokens: 0,
      cacheCreationEphemeral1hInputTokens: 85458
    },
    costUSD: 0.87578
  },
  {
    model: 'claude-opus-4-8',
    usage: {
      inputTokens: 34,
      outputTokens: 15929,
      cacheReadInputTokens: 1233014,
      cacheCreationEphemeral5mInputTokens: 0,
      cacheCreationEphemeral1hInputTokens: 67118
    },
    costUSD: 1.686082
  },
  {
    // Older record layout (one cacheCreationInputTokens total, billed as
    // 5-minute writes) and a web search.
    model: 'claude-haiku-4-5-20251001',
    usage: {
      inputTokens: 30701,
      outputTokens: 28574,
      cacheReadInputTokens: 3462340,
      cacheCreationEphemeral5mInputTokens: 305336,
      cacheCreationEphemeral1hInputTokens: 0,
      webSearchRequests: 1
    },
    costUSD: 0.911475
  }
]

const ZERO: TokenCounts = { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }

describe('pricing: matches Claude Code cost-state (issue #16 regression)', () => {
  for (const { model, usage, costUSD } of COST_STATE) {
    it(`${model} reproduces /cost within 1 %`, () => {
      const tokens: TokenCounts = {
        input: usage.inputTokens,
        output: usage.outputTokens,
        cacheRead: usage.cacheReadInputTokens,
        cacheWrite5m: usage.cacheCreationEphemeral5mInputTokens,
        cacheWrite1h: usage.cacheCreationEphemeral1hInputTokens
      }
      const cost = costOf(model, tokens, { webSearches: usage.webSearchRequests ?? 0 })
      const error = Math.abs(cost / costUSD - 1)
      assert.ok(error < 0.01, `${model}: $${cost.toFixed(4)} vs $${costUSD}`)
    })
  }

  it('new models resolve to their own row, not to their predecessor', () => {
    for (const [id, label] of [
      ['claude-opus-5-5', 'Opus 5.5'],
      ['claude-fable-5-2', 'Fable 5.2'],
      ['claude-sonnet-5-5', 'Sonnet 5.5'],
      ['claude-haiku-5-5', 'Haiku 5.5']
    ]) {
      const price = priceFor(id)
      assert.equal(price?.label, label)
      assert.equal(price?.approximate, false)
    }
  })

  it('an unknown id is approximate, even when it starts with a known one', () => {
    assert.equal(priceFor('claude-opus-9-9')?.approximate, true)
    assert.equal(priceFor('claude-opus-5-7')?.approximate, true)
    assert.equal(priceFor('claude-sonnet-5-5-preview')?.approximate, true)
    // A date suffix is the only thing stripped before an exact match.
    assert.equal(priceFor('claude-sonnet-5-5-20261101')?.approximate, false)
  })

  it("cache reads use each model's own rate", () => {
    const read = (model: string): number => costOf(model, { ...ZERO, cacheRead: 1_000_000 })
    assert.equal(read('claude-opus-5-5'), 0.2)
    assert.equal(read('claude-sonnet-5-5'), 0.1)
    assert.equal(read('claude-fable-5-2'), 0.2)
    assert.equal(read('claude-fable-5'), 1)
    assert.equal(read('claude-opus-5'), 0.5)
  })

  it('Haiku 5.5 charges the higher tier above 100K prompt tokens, per request', () => {
    const near = (a: number, b: number): void => assert.ok(Math.abs(a - b) < 1e-12, `${a} != ${b}`)
    const prompt = (input: number, cacheRead = 0): TokenCounts => ({
      ...ZERO,
      input,
      cacheRead,
      output: 1000
    })
    // 100,000 is not "over" 100,000.
    near(costOf('claude-haiku-5-5', prompt(100_000)), 0.01 + 0.0005)
    near(costOf('claude-haiku-5-5', prompt(100_001)), 0.0500005 + 0.0025)
    // Cache reads count toward the prompt size, and are billed at the higher tier too.
    near(costOf('claude-haiku-5-5', prompt(10_000, 140_000)), 0.005 + 0.007 + 0.0025)
  })

  it('fast mode, US-only inference and web searches', () => {
    const near = (a: number, b: number): void => assert.ok(Math.abs(a - b) < 1e-12, `${a} != ${b}`)
    const input = { ...ZERO, input: 1_000_000 }
    const output = { ...ZERO, output: 1_000_000 }
    assert.equal(costOf('claude-opus-5-5', input, { fast: true }), 8)
    assert.equal(costOf('claude-opus-5-5', output, { fast: true }), 40)
    // No fast-mode price is listed for Sonnet: standard rates apply.
    assert.equal(costOf('claude-sonnet-5-5', input, { fast: true }), 2)
    near(costOf('claude-opus-5-5', input, { usOnly: true }), 4.4)
    // Models before 4.6 have no US-only premium.
    assert.equal(costOf('claude-haiku-4-5', input, { usOnly: true }), 1)
    near(costOf('claude-opus-5-5', ZERO, { webSearches: 3 }), 0.03)
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

  it('prices each turn on its own prompt size, not on the session total (issue #16)', () => {
    const project = fakeRoot()
    writeTranscript(project, 'haiku55-session', [
      makeRow({ id: 'k1', model: 'claude-haiku-5-5', uso: { input: 50_000 } }),
      makeRow({ id: 'k2', model: 'claude-haiku-5-5', uso: { input: 150_000 } })
    ])

    rescan()
    // 50K at $0.10 plus 150K at $0.50 (over 100K). Pricing the 200K sum as a
    // single request would give $0.10.
    const cost = sessionUsage()['haiku55-session'].cost
    assert.ok(Math.abs(cost - 0.08) < 1e-12, `cost ${cost}`)
  })

  it('counts web searches reported in usage (issue #16)', () => {
    const project = fakeRoot()
    writeTranscript(project, 'search-session', [
      JSON.stringify({
        type: 'assistant',
        message: {
          id: 'w1',
          model: 'claude-sonnet-5-5',
          usage: { input_tokens: 0, output_tokens: 1, server_tool_use: { web_search_requests: 2 } }
        }
      })
    ])

    rescan()
    const cost = sessionUsage()['search-session'].cost
    assert.ok(Math.abs(cost - (0.02 + 0.00001)) < 1e-12, `cost ${cost}`)
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
