import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  ACTION_LABELS,
  DEFAULT_KEYMAP,
  editableActions,
  installKeyHandler,
  keyForAction,
  normalizeCombo,
  prettyKey,
  resolveKeymap,
  signature,
  type Action
} from '../src/renderer/src/keys/bindings'

/**
 * Fake event: `signature` reads only these fields, and building them by hand
 * reproduces keyboards that are not here (Italian, French) without depending
 * on the layout of whoever runs the tests.
 */
interface MockKeyEvent {
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  metaKey: boolean
  key: string
  code: string
  blocked: boolean
  preventDefault(): void
  stopPropagation(): void
}

function keyEvent(spec: {
  key: string
  /** Absent when the key has no interesting `code` (arrows, F11...). */
  code?: string
  ctrl?: boolean
  alt?: boolean
  shift?: boolean
  meta?: boolean
}): MockKeyEvent {
  const e: MockKeyEvent = {
    ctrlKey: spec.ctrl ?? false,
    altKey: spec.alt ?? false,
    shiftKey: spec.shift ?? false,
    metaKey: spec.meta ?? false,
    key: spec.key,
    code: spec.code ?? '',
    blocked: false,
    preventDefault() {
      e.blocked = true
    },
    stopPropagation() {}
  }
  return e
}

/** `signature` takes a real KeyboardEvent; its shape is enough here. */
function eventSignature(e: MockKeyEvent): string {
  return signature(e as unknown as KeyboardEvent)
}

describe('normalizeCombo: preserving keys during normalization (issue #7 regression)', () => {
  /**
   * Whoever assigned Alt+Space or Alt+Shift++ lost the old shortcut and did not
   * get a new one: the key was dropped and the last modifier taken for the key.
   * Both combinations must survive whole.
   */
  it('preserves space bar key', () => {
    assert.equal(normalizeCombo('alt+ '), 'alt+ ')
    assert.equal(normalizeCombo('ctrl+shift+ '), 'ctrl+shift+ ')
    // Without modifiers it is still a key, not an empty string.
    assert.equal(normalizeCombo(' '), ' ')
  })

  it('preserves + key even when following other + characters', () => {
    assert.equal(normalizeCombo('alt+shift++'), 'alt+shift++')
    assert.equal(normalizeCombo('alt++'), 'alt++')
    assert.equal(normalizeCombo('+'), '+')
  })

  it('never collapses combo down to just modifier', () => {
    // The visible symptom of the defect: the panel showed "Alt" as the assigned
    // key, and the user was left with a useless shortcut.
    for (const raw of ['alt+ ', 'alt++', 'alt+shift++', 'ctrl+shift+ ']) {
      const combo = normalizeCombo(raw)
      assert.notEqual(combo, 'alt', `${raw} collapsed to modifier`)
      assert.notEqual(combo, 'shift', `${raw} collapsed to modifier`)
      assert.notEqual(combo, 'alt+shift', `${raw} collapsed to modifier`)
      assert.notEqual(combo, 'ctrl+shift', `${raw} collapsed to modifier`)
    }
  })

  it('saved combo matches keyboard event signature', () => {
    // The real purpose of normalization: what the panel writes to the file must
    // match the signature the event will produce when the key is pressed.
    assert.equal(normalizeCombo('alt+ '), eventSignature(keyEvent({ key: ' ', code: 'Space', alt: true })))
    // On an Italian keyboard '+' is typed with Shift and the ']' key.
    assert.equal(
      normalizeCombo('alt+shift++'),
      eventSignature(keyEvent({ key: '+', code: 'BracketRight', alt: true, shift: true }))
    )
  })

  it('remapping an action to Alt+Space sets it cleanly', () => {
    // The exact sequence the panel writes when remapping: the old entry is freed
    // and the new one added. Before the fix the first half worked and the second
    // landed on 'alt', leaving the action without a key.
    const { keymap, problems } = resolveKeymap({ 'alt+z': '', 'alt+ ': 'toggle-zoom' })

    assert.deepEqual(problems, [])
    assert.equal(keymap['alt+ '], 'toggle-zoom')
    assert.equal(keymap['alt+z'], undefined)
    // No ghost entry on the bare modifier: it would intercept Alt on its own.
    assert.equal(keymap['alt'], undefined)
    assert.equal(keyForAction('toggle-zoom', keymap), prettyKey('alt+ '))
  })

  it('displays readable label for space bar', () => {
    // Found while writing this suite: prettyKey('alt+ ') returned 'Alt+ ', which
    // on screen reads "Alt+", the same as a broken shortcut. Whoever assigned
    // Alt+Space had no way to see that the key was there.
    assert.equal(prettyKey('alt+ '), 'Alt+Space')
  })
})

describe('ACTION_LABELS: all actions visible and remappable (issue #14 regression)', () => {
  const labeled = new Set(ACTION_LABELS.map((v) => v.action))
  const assigned = new Set<Action>(Object.values(DEFAULT_KEYMAP))

  it('every action in default map appears in panel', () => {
    // The nine focus-1..focus-9 were missing: they could not be discovered,
    // remapped or freed, and nothing revealed it.
    const missing = [...assigned].filter((a) => !labeled.has(a))
    assert.deepEqual(missing, [], `actions missing from panel: ${missing.join(', ')}`)
  })

  it('all nine numeric focus shortcuts are listed', () => {
    for (let i = 1; i <= 9; i++) {
      const action = `focus-${i}` as Action
      assert.ok(labeled.has(action), `${action} is not in panel`)
      assert.ok(assigned.has(action), `${action} has no default combination`)
    }
  })

  it('every panel row corresponds to an existing action', () => {
    // A row without an action would show a shortcut that does nothing.
    const orphans = [...labeled].filter((a) => !assigned.has(a))
    assert.deepEqual(orphans, [], `panel rows without corresponding action: ${orphans.join(', ')}`)
  })

  it('no duplicate rows or ambiguous labels', () => {
    // Two rows with the same action or the same text are indistinguishable: the
    // user remaps one and sees the other change.
    assert.equal(labeled.size, ACTION_LABELS.length, 'duplicate action in panel')
    const labels = new Set(ACTION_LABELS.map((v) => v.label))
    assert.equal(labels.size, ACTION_LABELS.length, 'duplicate label in panel')
    for (const { action, label } of ACTION_LABELS) {
      assert.ok(label.trim().length > 0, `${action} has empty label`)
    }
  })
})

describe('default keymap: no collisions and canonical form', () => {
  it('no combination maps to multiple actions', () => {
    // A duplicate in the literal would vanish silently: the symptom is fewer
    // assigned actions than declared combinations.
    const combos = Object.keys(DEFAULT_KEYMAP)
    const actions = new Set(Object.values(DEFAULT_KEYMAP))
    assert.equal(
      actions.size,
      combos.length,
      'combination overwritten: distinct actions differ from entry count'
    )
  })

  it('every default combination is already canonical', () => {
    // If it were not, the combination the panel saves (normalized) would never
    // match the default one, and the action would stay mute.
    for (const combo of Object.keys(DEFAULT_KEYMAP)) {
      assert.equal(normalizeCombo(combo), combo, `${combo} is not in canonical form`)
    }
  })

  it('no combination binds Ctrl and Alt simultaneously', () => {
    // On an Italian keyboard AltGr produces ctrlKey+altKey: intercepting one of
    // those combinations would take characters such as @ # [ ] { } away from
    // whoever types them.
    for (const combo of Object.keys(DEFAULT_KEYMAP)) {
      const mods = combo.split('+')
      assert.ok(
        !(mods.includes('ctrl') && mods.includes('alt')),
        `${combo} would conflict with AltGr`
      )
    }
  })
})

describe('signature: layout-independent key identification', () => {
  it('letters and digits derive from code, not produced character', () => {
    // On non-QWERTY keyboards the character changes but the position does not:
    // Alt+B must stay Alt+B, otherwise the shortcut moves with the layout.
    assert.equal(eventSignature(keyEvent({ key: 'ß', code: 'KeyB', alt: true })), 'alt+b')
    assert.equal(eventSignature(keyEvent({ key: 'B', code: 'KeyB', alt: true, shift: true })), 'alt+shift+b')
    // Digits: on a French layout Alt+1 produces '&'.
    assert.equal(eventSignature(keyEvent({ key: '&', code: 'Digit1', alt: true })), 'alt+1')
    assert.equal(DEFAULT_KEYMAP[eventSignature(keyEvent({ key: '&', code: 'Digit1', alt: true }))], 'focus-1')
  })

  it('special keys match keymap names', () => {
    assert.equal(eventSignature(keyEvent({ key: 'ArrowLeft', alt: true })), 'alt+left')
    assert.equal(eventSignature(keyEvent({ key: 'ArrowRight', alt: true, shift: true })), 'alt+shift+right')
    assert.equal(eventSignature(keyEvent({ key: 'ArrowUp', alt: true })), 'alt+up')
    assert.equal(eventSignature(keyEvent({ key: 'ArrowDown', alt: true })), 'alt+down')
    assert.equal(eventSignature(keyEvent({ key: 'Enter', alt: true })), 'alt+enter')
    assert.equal(eventSignature(keyEvent({ key: 'Escape' })), 'escape')
    assert.equal(eventSignature(keyEvent({ key: 'F11' })), 'f11')
  })

  it('modifiers appear in consistent canonical order', () => {
    // The order is the contract between event and map: changing it would mute
    // every shortcut with more than one modifier.
    assert.equal(
      eventSignature(keyEvent({ key: 'x', code: 'KeyX', meta: true, shift: true, alt: true, ctrl: true })),
      'ctrl+alt+shift+meta+x'
    )
    assert.equal(eventSignature(keyEvent({ key: 'q', code: 'KeyQ', ctrl: true, shift: true })), 'ctrl+shift+q')
    assert.equal(DEFAULT_KEYMAP[eventSignature(keyEvent({ key: 'q', code: 'KeyQ', ctrl: true, shift: true }))], 'quit')
  })

  it('AltGr never triggers default shortcuts', () => {
    // On an Italian keyboard AltGr = ctrlKey + altKey. If one of these ended up
    // in the map, the user could no longer type that character: the compositor
    // would intercept it and the terminal would never see it.
    const altgr = [
      keyEvent({ key: '@', code: 'Semicolon', ctrl: true, alt: true }),
      keyEvent({ key: '#', code: 'Quote', ctrl: true, alt: true }),
      keyEvent({ key: '[', code: 'BracketLeft', ctrl: true, alt: true }),
      keyEvent({ key: ']', code: 'BracketRight', ctrl: true, alt: true }),
      keyEvent({ key: '{', code: 'BracketLeft', ctrl: true, alt: true, shift: true }),
      keyEvent({ key: '}', code: 'BracketRight', ctrl: true, alt: true, shift: true }),
      // AltGr on a letter (€ on many layouts): the code turns it into 'e'.
      keyEvent({ key: '€', code: 'KeyE', ctrl: true, alt: true }),
      // AltGr on a digit, for the same reason.
      keyEvent({ key: '~', code: 'Digit1', ctrl: true, alt: true })
    ]

    for (const e of altgr) {
      const sig = eventSignature(e)
      assert.ok(sig.startsWith('ctrl+alt'), `${sig} missing both modifiers`)
      assert.equal(DEFAULT_KEYMAP[sig], undefined, `AltGr+${e.key} would be intercepted`)
    }
  })
})

describe('installKeyHandler: interception and passthrough to terminal', () => {
  /** Fake window: the listener is called by hand, without a DOM. */
  function withWindow(testFn: (press: (e: MockKeyEvent) => void, verifyDetached: () => void) => void): void {
    const listeners: ((e: KeyboardEvent) => void)[] = []
    const mockWindow = {
      addEventListener: (type: string, fn: (e: KeyboardEvent) => void) => {
        if (type === 'keydown') listeners.push(fn)
      },
      removeEventListener: (type: string, fn: (e: KeyboardEvent) => void) => {
        const i = listeners.indexOf(fn)
        if (i >= 0) listeners.splice(i, 1)
      }
    }
    const previous = (globalThis as Record<string, unknown>).window
    ;(globalThis as Record<string, unknown>).window = mockWindow
    try {
      testFn(
        (e) => {
          for (const fn of [...listeners]) fn(e as unknown as KeyboardEvent)
        },
        () => assert.equal(listeners.length, 0, 'listener was not removed')
      )
    } finally {
      ;(globalThis as Record<string, unknown>).window = previous
    }
  }

  it('executes mapped actions and forwards unmapped keys', () => {
    withWindow((press) => {
      const executed: Action[] = []
      const detach = installKeyHandler({ isEnabled: () => true, onAction: (a) => executed.push(a) })

      const inMap = keyEvent({ key: 'b', code: 'KeyB', alt: true })
      press(inMap)
      assert.deepEqual(executed, ['split-h'])
      assert.equal(inMap.blocked, true, 'mapped shortcut must be blocked')

      // Any letter, and an AltGr, must reach Claude Code intact.
      for (const e of [
        keyEvent({ key: 'a', code: 'KeyA' }),
        keyEvent({ key: '@', code: 'Semicolon', ctrl: true, alt: true }),
        keyEvent({ key: '[', code: 'BracketLeft', ctrl: true, alt: true })
      ]) {
        press(e)
        assert.equal(e.blocked, false, `${e.key} should not be intercepted`)
      }
      assert.deepEqual(executed, ['split-h'])

      detach()
    })
  })

  it('does not intercept when compositor key handler is disabled', () => {
    withWindow((press) => {
      const executed: Action[] = []
      installKeyHandler({ isEnabled: () => false, onAction: (a) => executed.push(a) })

      const e = keyEvent({ key: 'b', code: 'KeyB', alt: true })
      press(e)
      // With an overlay open the combination must reach the text field below, not
      // move the panes behind it.
      assert.deepEqual(executed, [])
      assert.equal(e.blocked, false)
    })
  })

  it('uses custom keymap and detaches completely', () => {
    withWindow((press, verifyDetached) => {
      const executed: Action[] = []
      const { keymap } = resolveKeymap({ 'alt+b': '', 'ctrl+shift+b': 'split-h' })
      const detach = installKeyHandler({
        keymap,
        isEnabled: () => true,
        onAction: (a) => executed.push(a)
      })

      const unbound = keyEvent({ key: 'b', code: 'KeyB', alt: true })
      press(unbound)
      // A freed Alt+B must go back to readline, not stay intercepted.
      assert.deepEqual(executed, [])
      assert.equal(unbound.blocked, false)

      press(keyEvent({ key: 'b', code: 'KeyB', ctrl: true, shift: true }))
      assert.deepEqual(executed, ['split-h'])

      detach()
      verifyDetached()
      press(keyEvent({ key: 'b', code: 'KeyB', ctrl: true, shift: true }))
      assert.deepEqual(executed, ['split-h'], 'listener continued responding after detach')
    })
  })
})

describe('normalizeCombo: canonical ordering and unknown modifiers', () => {
  it('reorders modifiers to match event signature output', () => {
    // The file is written by hand: nobody guesses the order the first time, and
    // a combination out of order would never match anything.
    assert.equal(normalizeCombo('shift+alt+b'), 'alt+shift+b')
    assert.equal(normalizeCombo('meta+shift+alt+ctrl+x'), 'ctrl+alt+shift+meta+x')
    assert.equal(normalizeCombo('shift+ctrl+q'), 'ctrl+shift+q')
    // And the result equals the signature of the matching event.
    assert.equal(normalizeCombo('shift+alt+b'), eventSignature(keyEvent({ key: 'b', code: 'KeyB', alt: true, shift: true })))
  })

  it('accepts uppercase, surrounding whitespace, and duplicate modifiers', () => {
    assert.equal(normalizeCombo('ALT+Shift+B'), 'alt+shift+b')
    assert.equal(normalizeCombo('alt + b'), 'alt+b')
    assert.equal(normalizeCombo(' alt+B '), 'alt+b')
    assert.equal(normalizeCombo('alt+alt+b'), 'alt+b')
  })

  it('rejects unsupported modifiers', () => {
    // Nothing is better than a plausible, wrong combination: 'super' would be
    // taken for the key, and the shortcut would fire at random.
    for (const raw of ['super+b', 'ctrl+super+b', 'cmd+k', 'option+b', 'alt+ctrlx+b', 'win+shift+b']) {
      assert.equal(normalizeCombo(raw), null, `${raw} should have been rejected`)
    }
  })

  it('does not invent modifiers when not present', () => {
    assert.equal(normalizeCombo('f11'), 'f11')
    assert.equal(normalizeCombo('ctrl'), 'ctrl')
  })
})

describe('resolveKeymap: malformed custom keymap handling', () => {
  it('returns default keymap when custom map is undefined', () => {
    const { keymap, problems } = resolveKeymap(undefined)
    assert.deepEqual(problems, [])
    assert.deepEqual(keymap, { ...DEFAULT_KEYMAP })
  })

  it('never mutates default keymap across calls', () => {
    // If the default map were mutated, a wrong change would stay in force even
    // after cleaning up the configuration file.
    resolveKeymap({ 'alt+n': '', 'alt+z': 'quit' })
    assert.equal(DEFAULT_KEYMAP['alt+n'], 'new-session')
    assert.equal(DEFAULT_KEYMAP['alt+z'], 'toggle-zoom')
    assert.deepEqual(resolveKeymap(undefined).keymap, { ...DEFAULT_KEYMAP })
  })

  it('discards unknown actions reporting problem', () => {
    const { keymap, problems } = resolveKeymap({
      'alt+k': 'kill-them-all',
      'alt+j': 'focus-1',
      'alt+h': 'Focus-1'
    })

    assert.equal(keymap['alt+k'], undefined)
    // Actions are case-sensitive: better to reject than to guess.
    assert.equal(keymap['alt+h'], undefined)
    assert.equal(keymap['alt+j'], 'focus-1')

    const reported = problems.map((p) => p.combo).sort()
    assert.deepEqual(reported, ['alt+h', 'alt+k'])
    for (const p of problems) {
      assert.ok(p.reason.length > 0, `${p.combo} discarded without reason`)
    }
  })

  it('discards malformed combinations and reports clearly', () => {
    // They must be listed, not ignored: whoever wrote 'super+b' needs to
    // understand why the shortcut does not work.
    const { keymap, problems } = resolveKeymap({ 'super+b': 'quit', 'cmd+k': 'close-pane' })

    assert.equal(problems.length, 2)
    assert.deepEqual(
      problems.map((p) => p.combo).sort(),
      ['cmd+k', 'super+b']
    )
    // No fallback reading: no 'b' or 'k' ended up in the map.
    assert.equal(keymap['b'], undefined)
    assert.equal(keymap['k'], undefined)
    assert.equal(keymap['ctrl+shift+q'], 'quit')
  })

  it('explains accurate reason for malformed combinations', () => {
    // Found while writing this suite: 'super+b' was rejected with the reason
    // "empty combination", which is not what the user wrote. The message sent
    // them looking for the problem in the wrong place.
    const { problems } = resolveKeymap({ 'super+b': 'quit' })
    assert.ok(
      /modifier/i.test(problems[0].reason),
      `misleading reason: ${problems[0].reason}`
    )
  })

  it('rejects empty combination string', () => {
    // Found while writing this suite: normalizeCombo('') returned '+', so an
    // empty line in the file silently bound the '+' key to an action. Whoever
    // typed '+' in the terminal saw it eaten without knowing why, and the entry
    // did not show up among the problems.
    assert.equal(normalizeCombo(''), null)
    const { keymap, problems } = resolveKeymap({ '': 'quit' })
    assert.equal(keymap['+'], undefined)
    assert.equal(problems.length, 1)
  })

  it('merges customizations on top of defaults rather than replacing', () => {
    // Whoever moves a single combination must not redeclare the other twenty.
    const { keymap, problems } = resolveKeymap({ 'alt+z': 'toggle-usage' })
    assert.deepEqual(problems, [])
    assert.equal(keymap['alt+z'], 'toggle-usage')
    assert.equal(keymap['alt+n'], 'new-session')
    assert.equal(Object.keys(keymap).length, Object.keys(DEFAULT_KEYMAP).length)
  })

  it('empty action unbinds combination', () => {
    // The only way to give Alt+B back to readline without replacing it.
    const { keymap, problems } = resolveKeymap({ 'alt+b': '' })
    assert.deepEqual(problems, [])
    assert.equal(keymap['alt+b'], undefined)
    assert.equal(keyForAction('split-h', keymap), null)
  })

  it('unbinding unmapped shortcut is not an error', () => {
    const { keymap, problems } = resolveKeymap({ 'alt+shift+p': '' })
    assert.deepEqual(problems, [])
    assert.deepEqual(keymap, { ...DEFAULT_KEYMAP })
  })

  it('out-of-order combination overrides default counterpart', () => {
    // Without normalization a dead entry would be added next to the old one, and
    // the user would see the original action still respond.
    const { keymap } = resolveKeymap({ 'SHIFT+Alt+left': 'toggle-usage' })
    assert.equal(keymap['alt+shift+left'], 'toggle-usage')
    assert.equal(keymap['shift+alt+left'], undefined)
    assert.equal(Object.keys(keymap).length, Object.keys(DEFAULT_KEYMAP).length)
  })

  it('different casings/orderings of same combination do not create duplicates', () => {
    // 'shift+alt+b' and 'alt+shift+b' are the same key: only one may remain,
    // with the last one written winning, otherwise which one acts would depend
    // on the map's internal order.
    const { keymap } = resolveKeymap({ 'shift+alt+b': 'toggle-usage', 'alt+shift+b': 'quit' })
    const matching = Object.keys(keymap).filter(
      (c) => normalizeCombo(c) === 'alt+shift+b'
    )
    assert.deepEqual(matching, ['alt+shift+b'])
    assert.equal(keymap['alt+shift+b'], 'quit')
  })

  it('resolved map remains compatible with real events', () => {
    // Whole-picture proof: after a customization, every combination in the map
    // is still canonical and none uses Ctrl+Alt (AltGr).
    const { keymap } = resolveKeymap({ 'Shift+ALT+b': 'toggle-usage', 'alt+ ': 'search-pane' })
    for (const combo of Object.keys(keymap)) {
      assert.equal(normalizeCombo(combo), combo, `${combo} is not canonical`)
      const parts = combo.split('+')
      assert.ok(!(parts.includes('ctrl') && parts.includes('alt')), `${combo} conflicts with AltGr`)
    }
  })
})

describe('prettyKey and keyForAction: user-facing labels', () => {
  it('translates modifiers and arrow keys', () => {
    assert.equal(prettyKey('alt+shift+left'), 'Alt+Shift+←')
    assert.equal(prettyKey('alt+enter'), 'Alt+Enter')
    assert.equal(prettyKey('ctrl+shift+q'), 'Ctrl+Shift+Q')
    assert.equal(prettyKey('f11'), 'F11')
  })

  it('returns key label for action or null if unbound', () => {
    assert.equal(keyForAction('quit'), 'Ctrl+Shift+Q')
    assert.equal(keyForAction('focus-1'), 'Alt+1')
    const { keymap } = resolveKeymap({ 'ctrl+shift+q': '' })
    assert.equal(keyForAction('quit', keymap), null)
  })
})

describe('DevTools shortcut in packaged builds (issue #19 regression)', () => {
  it('drops F12 when DevTools are off, so the key reaches the terminal', () => {
    const { keymap } = resolveKeymap(undefined, { devTools: false })
    assert.equal(keymap.f12, undefined)
    assert.ok(!Object.values(keymap).includes('toggle-devtools'))
  })

  it('drops a custom combination bound to DevTools as well', () => {
    const { keymap, problems } = resolveKeymap(
      { 'ctrl+shift+i': 'toggle-devtools' },
      { devTools: false }
    )
    assert.equal(keymap['ctrl+shift+i'], undefined)
    assert.deepEqual(problems, [])
  })

  it('keeps F12 in development', () => {
    assert.equal(resolveKeymap(undefined).keymap.f12, 'toggle-devtools')
    assert.equal(resolveKeymap(undefined, { devTools: true }).keymap.f12, 'toggle-devtools')
  })

  it('hides the action from the shortcut editor only when DevTools are off', () => {
    assert.ok(!editableActions(false).some((a) => a.action === 'toggle-devtools'))
    assert.equal(editableActions(true).length, ACTION_LABELS.length)
    assert.equal(editableActions(false).length, ACTION_LABELS.length - 1)
  })
})
