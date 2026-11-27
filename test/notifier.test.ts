import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  FINISH_DEBOUNCE_MS,
  decideNotices,
  dueFinished,
  noticeText
} from '../src/main/notify/notifier'
import type { LiveSession, MonitorPane } from '@shared/types'

/**
 * `decideNotices` is the core of M11: it decides whether the user gets
 * interrupted or not.
 *
 * Everything that can go wrong is here (recognizing the transition, staying
 * quiet on the first sighting, not insisting, not intruding on other people's
 * sessions), while showing the notification is a single line. If this
 * function gets it wrong, either the alert does not come when it is needed
 * (and the feature might as well not exist) or it comes in bursts (and the
 * user turns it off).
 */

/** Per-session memory: the same content as the notifier's internal memory. */
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

/** Labels of the notified panes: the only thing the user really sees. */
function notifiedLabels(notices: { pane: MonitorPane }[]): string[] {
  return notices.map((n) => n.pane.label)
}

describe('notifier: memory across polling cycles — Regression test for issue #2', () => {
  it('notifies on return after a single cycle absence from registry', () => {
    // The registry is REWRITTEN exactly when the status changes, so for one poll
    // the session can be missing. Forgetting it at once made its return with
    // 'waiting' look like a first sighting, and no alert went out: the feature
    // failed in the most likely case, that is, always.
    const memory = new Map<string, MemoryEntry>()
    const panes = [monitorPane('s1', 'API')]

    decideNotices([liveSession('s1', 'busy')], panes, memory)
    assert.deepEqual(notifiedLabels(decideNotices([], panes, memory)), [], 'empty cycle does not notify')

    const after = decideNotices([liveSession('s1', 'waiting')], panes, memory)
    assert.deepEqual(notifiedLabels(after), ['API'], 'returning to waiting after a gap must notify')
  })

  it('survives up to four consecutive absent cycles', () => {
    // The margin is more than one poll: several close rewrites of the registry
    // must not be enough to lose track.
    const memory = new Map<string, MemoryEntry>()
    const panes = [monitorPane('s1', 'API')]

    decideNotices([liveSession('s1', 'busy')], panes, memory)
    for (let i = 0; i < 4; i++) decideNotices([], panes, memory)

    assert.deepEqual(notifiedLabels(decideNotices([liveSession('s1', 'waiting')], panes, memory)), ['API'])
  })

  it('forgets sessions gone permanently', () => {
    // The other half of the issue: if the memory never expired, the map would
    // grow with every closed session for as long as the app stays open.
    const memory = new Map<string, MemoryEntry>()
    const panes = [monitorPane('s1', 'API')]

    decideNotices([liveSession('s1', 'busy')], panes, memory)
    assert.equal(memory.size, 1)

    for (let i = 0; i < 20; i++) decideNotices([], panes, memory)
    assert.equal(memory.size, 0, 'memory of permanently vanished session should clear')
  })

  it('does not accumulate memory of transient sessions', () => {
    // Thirty short sessions, one at a time: if each left a trace, memory would
    // grow without limit over a normal working day.
    const memory = new Map<string, MemoryEntry>()
    for (let i = 0; i < 30; i++) {
      decideNotices([liveSession(`s${i}`, 'busy')], [], memory)
      for (let round = 0; round < 5; round++) decideNotices([], [], memory)
    }
    assert.equal(memory.size, 0)
  })

  it('absence counts from the last sighting, not the first', () => {
    // A long session that flickers several times must not be forgotten by adding
    // up absences far apart from each other.
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
    // The base case that justifies the whole feature.
    const memory = new Map<string, MemoryEntry>()
    const panes = [monitorPane('s1', 'API')]

    decideNotices([liveSession('s1', 'busy')], panes, memory)
    const notices = decideNotices([liveSession('s1', 'waiting')], panes, memory)

    assert.equal(notices.length, 1)
    assert.equal(notices[0].pane.label, 'API')
    assert.equal(notices[0].kind, 'waiting')
    assert.equal(notices[0].pane.claudeSessionId, 's1', 'notice must carry correct session id')
  })

  it('does not repeat notice while session remains in waiting', () => {
    // The registry is rewritten often: a burst of notifications for a single wait
    // is the fastest way to get the user to turn the feature off.
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
    // Answering and then being called again is a new event: the alert is needed
    // again here, otherwise the second wait would go unnoticed.
    const memory = new Map<string, MemoryEntry>()
    const panes = [monitorPane('s1', 'API')]

    decideNotices([liveSession('s1', 'busy')], panes, memory)
    decideNotices([liveSession('s1', 'waiting')], panes, memory)
    decideNotices([liveSession('s1', 'busy')], panes, memory)

    assert.deepEqual(notifiedLabels(decideNotices([liveSession('s1', 'waiting')], panes, memory)), ['API'])
  })

  it('silences on first sighting even if session is already waiting', () => {
    // When the app starts, every live session is "new": alerting on the first
    // poll would produce a burst for waits the user already knows about.
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
    // decideNotices answers for waiting only. A finished turn (idle) is
    // announced later by dueFinished, once the idle has lasted (#24).
    const memory = new Map<string, MemoryEntry>()
    const panes = [monitorPane('s1', 'API')]

    decideNotices([liveSession('s1', 'waiting')], panes, memory)
    assert.deepEqual(notifiedLabels(decideNotices([liveSession('s1', 'busy')], panes, memory)), [])
    assert.deepEqual(notifiedLabels(decideNotices([liveSession('s1', 'idle')], panes, memory)), [])
  })

  it('notifies for every session transitioning to waiting in the same cycle', () => {
    // Three panes stopping together are three things to do: missing two of them
    // would be worse than not alerting at all.
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
    // The registry lists every live Claude Code on the machine, including those
    // opened in another terminal: interrupting the user for them would intrude on
    // work the app neither shows nor controls.
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
    // A pane with a null `claudeSessionId` is a terminal without Claude: it must
    // not latch on to the first session that comes by.
    const memory = new Map<string, MemoryEntry>()
    const panes = [monitorPane(null, 'Terminal')]

    decideNotices([liveSession('s1', 'busy')], panes, memory)
    assert.deepEqual(notifiedLabels(decideNotices([liveSession('s1', 'waiting')], panes, memory)), [])
  })

  it('notifies previously external session once attached to a pane', () => {
    // Ownership is evaluated on every poll: linking a pane to a session already
    // seen must not exclude it from alerts forever.
    const memory = new Map<string, MemoryEntry>()

    decideNotices([liveSession('s1', 'busy')], [], memory)
    const notices = decideNotices([liveSession('s1', 'waiting')], [monitorPane('s1', 'API')], memory)

    assert.deepEqual(notifiedLabels(notices), ['API'])
  })
})

describe('notifier: sessions without status', () => {
  it('does not notify for a session missing status', () => {
    // An incomplete registry, or one from a different version, must not produce
    // alerts: an unknown status is not a wait.
    const memory = new Map<string, MemoryEntry>()
    const panes = [monitorPane('s1', 'API')]

    decideNotices([liveSession('s1', 'busy')], panes, memory)
    const notices = decideNotices([liveSession('s1')], panes, memory)

    assert.deepEqual(notifiedLabels(notices), [])
  })

  it('notifies when session without status transitions to waiting', () => {
    // The transition counts even from an unknown status, otherwise a session seen
    // before the registry was complete would stay mute.
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
    // The caller owns the memory: if the function did not update it, every poll
    // would be a first sighting and no alert would ever go out.
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
    // Two different maps are two different stories: no hidden global state.
    const panes = [monitorPane('s1', 'API')]
    const first = new Map<string, MemoryEntry>()

    decideNotices([liveSession('s1', 'busy')], panes, first)
    assert.deepEqual(notifiedLabels(decideNotices([liveSession('s1', 'waiting')], panes, new Map())), [])
  })
})

/**
 * Issue #24: the most frequent reason to look at a pane is that Claude finished
 * its turn (busy -> idle), and it produced no alert. The finish is decided in
 * two steps: decideNotices marks the transition, and dueFinished announces it
 * once the idle has lasted FINISH_DEBOUNCE_MS, so a short idle between two
 * steps of the same turn cannot trigger it.
 */
describe('notifier: finished turn (issue #24)', () => {
  const T0 = 1_000_000

  function finishAt(memory: Map<string, MemoryEntry>, panes: MonitorPane[], id = 's1'): void {
    decideNotices([liveSession(id, 'busy')], panes, memory, T0 - 10_000)
    decideNotices([liveSession(id, 'idle')], panes, memory, T0)
  }

  it('busy -> idle alerts once the idle has lasted the debounce', () => {
    const memory = new Map<string, MemoryEntry>()
    const panes = [monitorPane('s1', 'API')]
    finishAt(memory, panes)

    assert.deepEqual(notifiedLabels(dueFinished(panes, memory, T0 + FINISH_DEBOUNCE_MS - 1)), [])
    const due = dueFinished(panes, memory, T0 + FINISH_DEBOUNCE_MS)
    assert.deepEqual(notifiedLabels(due), ['API'])
    assert.equal(due[0].kind, 'finished')
    // Announced once: the next timer tick finds nothing.
    assert.deepEqual(dueFinished(panes, memory, T0 + 60_000), [])
  })

  it('an idle shorter than the debounce does not alert', () => {
    const memory = new Map<string, MemoryEntry>()
    const panes = [monitorPane('s1', 'API')]
    finishAt(memory, panes)
    // Back to work before the debounce: it was a pause, not the end of the turn.
    decideNotices([liveSession('s1', 'busy')], panes, memory, T0 + 500)
    assert.deepEqual(dueFinished(panes, memory, T0 + 10_000), [])
  })

  it('idle -> idle (a registry rewrite) does not restart or repeat the alert', () => {
    const memory = new Map<string, MemoryEntry>()
    const panes = [monitorPane('s1', 'API')]
    finishAt(memory, panes)
    // The rewrite keeps the original moment, so the debounce is not pushed back.
    decideNotices([liveSession('s1', 'idle')], panes, memory, T0 + 1000)
    assert.deepEqual(notifiedLabels(dueFinished(panes, memory, T0 + FINISH_DEBOUNCE_MS)), ['API'])
    decideNotices([liveSession('s1', 'idle')], panes, memory, T0 + 5000)
    assert.deepEqual(dueFinished(panes, memory, T0 + 60_000), [])
  })

  it('a session first seen idle is not a finish', () => {
    const memory = new Map<string, MemoryEntry>()
    const panes = [monitorPane('s1', 'API')]
    decideNotices([liveSession('s1', 'idle')], panes, memory, T0)
    assert.deepEqual(dueFinished(panes, memory, T0 + 60_000), [])
  })

  it('waiting -> idle is not a finish: only the end of real work counts', () => {
    const memory = new Map<string, MemoryEntry>()
    const panes = [monitorPane('s1', 'API')]
    decideNotices([liveSession('s1', 'waiting')], panes, memory, T0 - 1000)
    decideNotices([liveSession('s1', 'idle')], panes, memory, T0)
    assert.deepEqual(dueFinished(panes, memory, T0 + 60_000), [])
  })

  it('sessions of other terminals finish without an alert', () => {
    const memory = new Map<string, MemoryEntry>()
    const panes = [monitorPane('s1', 'API')]
    finishAt(memory, panes, 'foreign')
    assert.deepEqual(dueFinished(panes, memory, T0 + 60_000), [])
  })

  it('a session that exits right after its turn has nothing to announce', () => {
    const memory = new Map<string, MemoryEntry>()
    const panes = [monitorPane('s1', 'API')]
    finishAt(memory, panes)
    // /exit: the registry file goes away before the debounce ends.
    decideNotices([], panes, memory, T0 + 300)
    assert.deepEqual(dueFinished(panes, memory, T0 + 60_000), [])
  })

  it('several panes finishing together become one notice', () => {
    const memory = new Map<string, MemoryEntry>()
    const panes = [monitorPane('s1', 'API'), monitorPane('s2', 'Web')]
    decideNotices([liveSession('s1', 'busy'), liveSession('s2', 'busy')], panes, memory, T0 - 5000)
    decideNotices([liveSession('s1', 'idle'), liveSession('s2', 'idle')], panes, memory, T0)
    const due = dueFinished(panes, memory, T0 + FINISH_DEBOUNCE_MS)
    assert.deepEqual(notifiedLabels(due).sort(), ['API', 'Web'])
    assert.deepEqual(noticeText(due), { title: '2 sessions finished', body: 'API · Web' })
  })

  it('names the pane that finished, and the one that waits', () => {
    const memory = new Map<string, MemoryEntry>()
    const panes = [monitorPane('s1', 'API')]
    finishAt(memory, panes)
    const finished = dueFinished(panes, memory, T0 + FINISH_DEBOUNCE_MS)
    assert.equal(noticeText(finished).title, 'API finished')

    const waiting = decideNotices(
      [{ ...liveSession('s1', 'waiting'), waitingFor: 'Bash: npm test' }],
      panes,
      memory,
      T0 + 10_000
    )
    assert.deepEqual(noticeText(waiting), {
      title: 'API is waiting for input',
      body: 'Bash: npm test'
    })
  })
})
