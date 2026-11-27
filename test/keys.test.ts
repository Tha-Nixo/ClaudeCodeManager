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
 * Mock event: `signature` reads these properties. Constructing them manually
 * allows testing varied keyboard layouts without depending on runner layout.
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

function eventSignature(e: MockKeyEvent): string {
  return signature(e as unknown as KeyboardEvent)
}

describe('normalizeCombo: preserving keys during normalization (issue #7 regression)', () => {
  it('preserves space bar key', () => {
    assert.equal(normalizeCombo('alt+ '), 'alt+ ')
    assert.equal(normalizeCombo('ctrl+shift+ '), 'ctrl+shift+ ')
    assert.equal(normalizeCombo(' '), ' ')
  })

  it('preserves + key even when following other + characters', () => {
    assert.equal(normalizeCombo('alt+shift++'), 'alt+shift++')
    assert.equal(normalizeCombo('alt++'), 'alt++')
    assert.equal(normalizeCombo('+'), '+')
  })

  it('never collapses combo down to just modifier', () => {
    for (const raw of ['alt+ ', 'alt++', 'alt+shift++', 'ctrl+shift+ ']) {
      const combo = normalizeCombo(raw)
      assert.notEqual(combo, 'alt', `${raw} collapsed to modifier`)
      assert.notEqual(combo, 'shift', `${raw} collapsed to modifier`)
      assert.notEqual(combo, 'alt+shift', `${raw} collapsed to modifier`)
      assert.notEqual(combo, 'ctrl+shift', `${raw} collapsed to modifier`)
    }
  })

  it('saved combo matches keyboard event signature', () => {
    assert.equal(normalizeCombo('alt+ '), eventSignature(keyEvent({ key: ' ', code: 'Space', alt: true })))
    assert.equal(
      normalizeCombo('alt+shift++'),
      eventSignature(keyEvent({ key: '+', code: 'BracketRight', alt: true, shift: true }))
    )
  })

  it('remapping an action to Alt+Space sets it cleanly', () => {
    const { keymap, problems } = resolveKeymap({ 'alt+z': '', 'alt+ ': 'toggle-zoom' })

    assert.deepEqual(problems, [])
    assert.equal(keymap['alt+ '], 'toggle-zoom')
    assert.equal(keymap['alt+z'], undefined)
    assert.equal(keymap['alt'], undefined)
    assert.equal(keyForAction('toggle-zoom', keymap), prettyKey('alt+ '))
  })

  it('displays readable label for space bar', () => {
    assert.equal(prettyKey('alt+ '), 'Alt+Space')
  })
})

describe('ACTION_LABELS: all actions visible and remappable (issue #14 regression)', () => {
  const labeled = new Set(ACTION_LABELS.map((v) => v.action))
  const assigned = new Set<Action>(Object.values(DEFAULT_KEYMAP))

  it('every action in default map appears in panel', () => {
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
    const orphans = [...labeled].filter((a) => !assigned.has(a))
    assert.deepEqual(orphans, [], `panel rows without corresponding action: ${orphans.join(', ')}`)
  })

  it('no duplicate rows or ambiguous labels', () => {
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
    const combos = Object.keys(DEFAULT_KEYMAP)
    const actions = new Set(Object.values(DEFAULT_KEYMAP))
    assert.equal(
      actions.size,
      combos.length,
      'combination overwritten: distinct actions differ from entry count'
    )
  })

  it('every default combination is already canonical', () => {
    for (const combo of Object.keys(DEFAULT_KEYMAP)) {
      assert.equal(normalizeCombo(combo), combo, `${combo} is not in canonical form`)
    }
  })

  it('no combination binds Ctrl and Alt simultaneously', () => {
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
    assert.equal(eventSignature(keyEvent({ key: 'ß', code: 'KeyB', alt: true })), 'alt+b')
    assert.equal(eventSignature(keyEvent({ key: 'B', code: 'KeyB', alt: true, shift: true })), 'alt+shift+b')
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
    assert.equal(
      eventSignature(keyEvent({ key: 'x', code: 'KeyX', meta: true, shift: true, alt: true, ctrl: true })),
      'ctrl+alt+shift+meta+x'
    )
    assert.equal(eventSignature(keyEvent({ key: 'q', code: 'KeyQ', ctrl: true, shift: true })), 'ctrl+shift+q')
    assert.equal(DEFAULT_KEYMAP[eventSignature(keyEvent({ key: 'q', code: 'KeyQ', ctrl: true, shift: true }))], 'quit')
  })

  it('AltGr never triggers default shortcuts', () => {
    const altgr = [
      keyEvent({ key: '@', code: 'Semicolon', ctrl: true, alt: true }),
      keyEvent({ key: '#', code: 'Quote', ctrl: true, alt: true }),
      keyEvent({ key: '[', code: 'BracketLeft', ctrl: true, alt: true }),
      keyEvent({ key: ']', code: 'BracketRight', ctrl: true, alt: true }),
      keyEvent({ key: '{', code: 'BracketLeft', ctrl: true, alt: true, shift: true }),
      keyEvent({ key: '}', code: 'BracketRight', ctrl: true, alt: true, shift: true }),
      keyEvent({ key: '€', code: 'KeyE', ctrl: true, alt: true }),
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
    assert.equal(normalizeCombo('shift+alt+b'), 'alt+shift+b')
    assert.equal(normalizeCombo('meta+shift+alt+ctrl+x'), 'ctrl+alt+shift+meta+x')
    assert.equal(normalizeCombo('shift+ctrl+q'), 'ctrl+shift+q')
    assert.equal(normalizeCombo('shift+alt+b'), eventSignature(keyEvent({ key: 'b', code: 'KeyB', alt: true, shift: true })))
  })

  it('accepts uppercase, surrounding whitespace, and duplicate modifiers', () => {
    assert.equal(normalizeCombo('ALT+Shift+B'), 'alt+shift+b')
    assert.equal(normalizeCombo('alt + b'), 'alt+b')
    assert.equal(normalizeCombo(' alt+B '), 'alt+b')
    assert.equal(normalizeCombo('alt+alt+b'), 'alt+b')
  })

  it('rejects unsupported modifiers', () => {
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
    assert.equal(keymap['alt+h'], undefined)
    assert.equal(keymap['alt+j'], 'focus-1')

    const reported = problems.map((p) => p.combo).sort()
    assert.deepEqual(reported, ['alt+h', 'alt+k'])
    for (const p of problems) {
      assert.ok(p.reason.length > 0, `${p.combo} discarded without reason`)
    }
  })

  it('discards malformed combinations and reports clearly', () => {
    const { keymap, problems } = resolveKeymap({ 'super+b': 'quit', 'cmd+k': 'close-pane' })

    assert.equal(problems.length, 2)
    assert.deepEqual(
      problems.map((p) => p.combo).sort(),
      ['cmd+k', 'super+b']
    )
    assert.equal(keymap['b'], undefined)
    assert.equal(keymap['k'], undefined)
    assert.equal(keymap['ctrl+shift+q'], 'quit')
  })

  it('explains accurate reason for malformed combinations', () => {
    const { problems } = resolveKeymap({ 'super+b': 'quit' })
    assert.ok(
      /modifier/i.test(problems[0].reason),
      `misleading reason: ${problems[0].reason}`
    )
  })

  it('rejects empty combination string', () => {
    assert.equal(normalizeCombo(''), null)
    const { keymap, problems } = resolveKeymap({ '': 'quit' })
    assert.equal(keymap['+'], undefined)
    assert.equal(problems.length, 1)
  })

  it('merges customizations on top of defaults rather than replacing', () => {
    const { keymap, problems } = resolveKeymap({ 'alt+z': 'toggle-usage' })
    assert.deepEqual(problems, [])
    assert.equal(keymap['alt+z'], 'toggle-usage')
    assert.equal(keymap['alt+n'], 'new-session')
    assert.equal(Object.keys(keymap).length, Object.keys(DEFAULT_KEYMAP).length)
  })

  it('empty action unbinds combination', () => {
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
    const { keymap } = resolveKeymap({ 'SHIFT+Alt+left': 'toggle-usage' })
    assert.equal(keymap['alt+shift+left'], 'toggle-usage')
    assert.equal(keymap['shift+alt+left'], undefined)
    assert.equal(Object.keys(keymap).length, Object.keys(DEFAULT_KEYMAP).length)
  })

  it('different casings/orderings of same combination do not create duplicates', () => {
    const { keymap } = resolveKeymap({ 'shift+alt+b': 'toggle-usage', 'alt+shift+b': 'quit' })
    const matching = Object.keys(keymap).filter(
      (c) => normalizeCombo(c) === 'alt+shift+b'
    )
    assert.deepEqual(matching, ['alt+shift+b'])
    assert.equal(keymap['alt+shift+b'], 'quit')
  })

  it('resolved map remains compatible with real events', () => {
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
