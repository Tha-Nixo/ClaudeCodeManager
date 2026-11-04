import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { decideNotices } from '../src/main/notify/notifier'
import type { LiveSession, MonitorPane } from '@shared/types'

/**
 * `decideNotices` is the core of M11: it determines when the user should be alerted.
 *
 * It manages edge cases: detecting state transitions, silencing first sightings,
 * throttling repeat alerts, ignoring non-owned sessions.
 */

interface MemoryEntry {
  status: string
  missing: number
}

function liveSession(sessionId: string, status?: string): LiveSession {
  return { pid: 1000, sessionId, cwd: 'C:\\project', status }
}

function monitorPane(claudeSessionId: string | null, label = 'pane'): MonitorPane {
  return {
    paneId: `pane-${claudeSessionId ?? 'empty'}`,
    index: 0,
    label,
    where: 'C:\\project',
    status: 'idle',
    remote: false,
    claudeSessionId
  }
}

/** Labels of notified panes: what the user actually sees. */
function notifiedLabels(notices: { pane: MonitorPane }[]): string[] {
  return notices.map((n) => n.pane.label)
}

describe('notifier: memory across polling cycles — Regression test for issue #2', () => {
  it('notifies on return after a single cycle absence from registry', () => {
    // The registry is rewritten when status changes, so a session might briefly vanish for 1 cycle.
    const memory = new Map<string, MemoryEntry>()
    const panes = [monitorPane('s1', 'API')]

    decideNotices([liveSession('s1', 'busy')], panes, memory)
    assert.deepEqual(notifiedLabels(decideNotices([], panes, memory)), [], 'empty cycle does not notify')

    const after = decideNotices([liveSession('s1', 'waiting')], panes, memory)
    assert.deepEqual(notifiedLabels(after), ['API'], 'returning to waiting after a gap must notify')
  })

  it('survives up to four consecutive absent cycles', () => {
    const memory = new Map<string, MemoryEntry>()
    const panes = [monitorPane('s1', 'API')]

    decideNotices([liveSession('s1', 'busy')], panes, memory)
    for (let i = 0; i < 4; i++) decideNotices([], panes, memory)

    assert.deepEqual(notifiedLabels(decideNotices([liveSession('s1', 'waiting')], panes, memory)), ['API'])
  })

  it('forgets sessions gone permanently', () => {
    const memory = new Map<string, MemoryEntry>()
    const panes = [monitorPane('s1', 'API')]

    decideNotices([liveSession('s1', 'busy')], panes, memory)
    assert.equal(memory.size, 1)

    for (let i = 0; i < 20; i++) decideNotices([], panes, memory)
    assert.equal(memory.size, 0, 'memory of permanently vanished session should clear')
  })

  it('does not accumulate memory of transient sessions', () => {
    const memory = new Map<string, MemoryEntry>()
    for (let i = 0; i < 30; i++) {
      decideNotices([liveSession(`s${i}`, 'busy')], [], memory)
      for (let round = 0; round < 5; round++) decideNotices([], [], memory)
    }
    assert.equal(memory.size, 0)
  })

  it('absence counts from the last sighting, not the first', () => {
    const memory = new Map<string, MemoryEntry>()
    const panes = [monitorPane('s1', 'API')]

    decideNotices([liveSession('s1', 'busy')], panes, memory)
    for (let cycle = 0; cycle < 3; cycle++) {
      for (let i = 0; i < 4; i++) decideNotices([], panes, memory)
      decideNotices([liveSession('s1', 'busy')], panes, memory)
    }

    for (let i = 0; i < 4; i++) decideNotices([], panes, memory)
    assert.deepEqual(notifiedLabels(decideNotices([liveSession('s1', 'waiting')], panes, memory)), ['API'])
  })
})

describe('notifier: when to notify', () => {
  it('notifies on direct transition from busy to waiting', () => {
    const memory = new Map<string, MemoryEntry>()
    const panes = [monitorPane('s1', 'API')]

    decideNotices([liveSession('s1', 'busy')], panes, memory)
    const notices = decideNotices([liveSession('s1', 'waiting')], panes, memory)

    assert.equal(notices.length, 1)
    assert.equal(notices[0].pane.label, 'API')
    assert.equal(notices[0].live.sessionId, 's1', 'notice must carry correct session id')
  })

  it('does not repeat notice while session remains in waiting', () => {
    const memory = new Map<string, MemoryEntry>()
    const panes = [monitorPane('s1', 'API')]

    decideNotices([liveSession('s1', 'busy')], panes, memory)
    assert.equal(decideNotices([liveSession('s1', 'waiting')], panes, memory).length, 1)

    for (let i = 0; i < 5; i++) {
      assert.equal(
        decideNotices([liveSession('s1', 'waiting')], panes, memory).length,
        0,
        'remaining in waiting is not a new transition'
      )
    }
  })

  it('re-notifies if waiting resumes after session became busy again', () => {
    const memory = new Map<string, MemoryEntry>()
    const panes = [monitorPane('s1', 'API')]

    decideNotices([liveSession('s1', 'busy')], panes, memory)
    decideNotices([liveSession('s1', 'waiting')], panes, memory)
    decideNotices([liveSession('s1', 'busy')], panes, memory)

    assert.deepEqual(notifiedLabels(decideNotices([liveSession('s1', 'waiting')], panes, memory)), ['API'])
  })

  it('silences on first sighting even if session is already waiting', () => {
    const memory = new Map<string, MemoryEntry>()
    const panes = [monitorPane('s1', 'API'), monitorPane('s2', 'Web')]

    const notices = decideNotices(
      [liveSession('s1', 'waiting'), liveSession('s2', 'waiting')],
      panes,
      memory
    )

    assert.deepEqual(notifiedLabels(notices), [])
  })

  it('does not notify for transitions to states other than waiting', () => {
    const memory = new Map<string, MemoryEntry>()
    const panes = [monitorPane('s1', 'API')]

    decideNotices([liveSession('s1', 'waiting')], panes, memory)
    assert.deepEqual(notifiedLabels(decideNotices([liveSession('s1', 'busy')], panes, memory)), [])
    assert.deepEqual(notifiedLabels(decideNotices([liveSession('s1', 'idle')], panes, memory)), [])
  })

  it('notifies for every session transitioning to waiting in the same cycle', () => {
    const memory = new Map<string, MemoryEntry>()
    const panes = [monitorPane('s1', 'API'), monitorPane('s2', 'Web'), monitorPane('s3', 'Docs')]
    const busy = [liveSession('s1', 'busy'), liveSession('s2', 'busy'), liveSession('s3', 'busy')]

    decideNotices(busy, panes, memory)
    const notices = decideNotices(
      [liveSession('s1', 'waiting'), liveSession('s2', 'waiting'), liveSession('s3', 'waiting')],
      panes,
      memory
    )

    assert.deepEqual(notifiedLabels(notices).sort(), ['API', 'Docs', 'Web'])
  })

  it('notifies only transitioning session, not neighbors already waiting', () => {
    const memory = new Map<string, MemoryEntry>()
    const panes = [monitorPane('s1', 'API'), monitorPane('s2', 'Web')]

    decideNotices([liveSession('s1', 'waiting'), liveSession('s2', 'busy')], panes, memory)
    const notices = decideNotices(
      [liveSession('s1', 'waiting'), liveSession('s2', 'waiting')],
      panes,
      memory
    )

    assert.deepEqual(notifiedLabels(notices), ['Web'])
  })
})

describe('notifier: external sessions', () => {
  it('does not notify for a session not belonging to any pane', () => {
    const memory = new Map<string, MemoryEntry>()
    const panes = [monitorPane('s1', 'API')]

    decideNotices([liveSession('s1', 'busy'), liveSession('external', 'busy')], panes, memory)
    const notices = decideNotices(
      [liveSession('s1', 'busy'), liveSession('external', 'waiting')],
      panes,
      memory
    )

    assert.deepEqual(notifiedLabels(notices), [])
  })

  it('does not notify when no panes are open', () => {
    const memory = new Map<string, MemoryEntry>()

    decideNotices([liveSession('s1', 'busy')], [], memory)
    assert.deepEqual(notifiedLabels(decideNotices([liveSession('s1', 'waiting')], [], memory)), [])
  })

  it('ignores panes with no attached session', () => {
    const memory = new Map<string, MemoryEntry>()
    const panes = [monitorPane(null, 'Terminal')]

    decideNotices([liveSession('s1', 'busy')], panes, memory)
    assert.deepEqual(notifiedLabels(decideNotices([liveSession('s1', 'waiting')], panes, memory)), [])
  })

  it('notifies previously external session once attached to a pane', () => {
    const memory = new Map<string, MemoryEntry>()

    decideNotices([liveSession('s1', 'busy')], [], memory)
    const notices = decideNotices([liveSession('s1', 'waiting')], [monitorPane('s1', 'API')], memory)

    assert.deepEqual(notifiedLabels(notices), ['API'])
  })
})

describe('notifier: sessions without status', () => {
  it('does not notify for a session missing status', () => {
    const memory = new Map<string, MemoryEntry>()
    const panes = [monitorPane('s1', 'API')]

    decideNotices([liveSession('s1', 'busy')], panes, memory)
    const notices = decideNotices([liveSession('s1')], panes, memory)

    assert.deepEqual(notifiedLabels(notices), [])
  })

  it('notifies when session without status transitions to waiting', () => {
    const memory = new Map<string, MemoryEntry>()
    const panes = [monitorPane('s1', 'API')]

    decideNotices([liveSession('s1')], panes, memory)
    assert.deepEqual(notifiedLabels(decideNotices([liveSession('s1', 'waiting')], panes, memory)), ['API'])
  })

  it('two cycles without status produce no notifications', () => {
    const memory = new Map<string, MemoryEntry>()
    const panes = [monitorPane('s1', 'API')]

    decideNotices([liveSession('s1')], panes, memory)
    assert.deepEqual(notifiedLabels(decideNotices([liveSession('s1')], panes, memory)), [])
  })
})

describe('notifier: passed memory is updated in-place', () => {
  it('writes into passed map instead of retaining internal state', () => {
    const memory = new Map<string, MemoryEntry>()

    decideNotices([liveSession('s1', 'busy'), liveSession('s2')], [], memory)

    assert.deepEqual([...memory.keys()].sort(), ['s1', 's2'])
    assert.deepEqual(memory.get('s1'), { status: 'busy', missing: 0 })
    assert.deepEqual(memory.get('s2'), { status: 'unknown', missing: 0 })

    decideNotices([liveSession('s1', 'waiting')], [], memory)
    assert.deepEqual(memory.get('s1'), { status: 'waiting', missing: 0 })
    assert.equal(memory.get('s2')?.missing, 1, 'missing sessions increment missing count')
  })

  it('starts clean with a new map, with no state shared across calls', () => {
    const panes = [monitorPane('s1', 'API')]
    const first = new Map<string, MemoryEntry>()

    decideNotices([liveSession('s1', 'busy')], panes, first)
    assert.deepEqual(notifiedLabels(decideNotices([liveSession('s1', 'waiting')], panes, new Map())), [])
  })
})
