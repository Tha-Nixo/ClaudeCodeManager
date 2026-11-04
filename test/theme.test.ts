import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { validateTheme, type Theme } from '../src/shared/theme'
import { BUILTIN_THEMES, DEFAULT_THEME_ID } from '../src/shared/themes/builtin'

/**
 * A theme is the first visual element rendered by the app: if validation
 * permits a partially malformed theme, the result is an unreadable UI.
 * Rejection messages must clearly specify the erroneous field so user-edited
 * theme JSON files can be easily corrected.
 */

type RawTheme = Record<string, unknown>

/**
 * Baseline for negative tests: a deep clone of a built-in theme.
 * Mutating a single field isolates failures to that specific field.
 */
function cloneTheme(id = 'claude-light'): RawTheme {
  const base = BUILTIN_THEMES.find((t) => t.id === id)
  assert.ok(base, `missing built-in theme: ${id}`)
  return JSON.parse(JSON.stringify(base)) as RawTheme
}

function ui(theme: RawTheme): RawTheme {
  return theme.ui as RawTheme
}

function terminal(theme: RawTheme): RawTheme {
  return theme.terminal as RawTheme
}

function assertAccepted(raw: unknown, context: string): Theme {
  const { theme, error } = validateTheme(raw)
  assert.equal(error, null, `${context}: rejected with "${error}"`)
  assert.ok(theme, `${context}: accepted but theme missing`)
  return theme
}

function assertRejected(raw: unknown, fieldPattern: RegExp, context: string): string {
  const { theme, error } = validateTheme(raw)
  assert.equal(theme, null, `${context}: accepted instead of rejected`)
  assert.ok(typeof error === 'string' && error.length > 0, `${context}: rejected without message`)
  assert.match(error, fieldPattern, `${context}: message does not identify field`)
  return error
}

const UI_KEYS = [
  'desktop',
  'panel',
  'panelRaised',
  'borderIdle',
  'borderFocus',
  'text',
  'textDim',
  'accent',
  'ok',
  'waiting',
  'error'
] as const

const TERM_KEYS = ['background', 'foreground', 'cursor', 'selection'] as const

const INVALID_COLORS = [
  'red',
  '#GGG',
  '#12345',
  'rgb(1,2,3)',
  '#1234567',
  'FFFFFF',
  '#',
  '',
  '  #ffffff  ',
  null,
  123,
  true,
  ['#ffffff'],
  { hex: '#ffffff' }
]

describe('issue #15 regression: dark must be a strict boolean', () => {
  it('baseline theme is light and valid', () => {
    const theme = assertAccepted(cloneTheme('claude-light'), 'cloned claude-light')
    assert.equal(theme.dark, false, 'baseline theme should be light')
  })

  it('rejects "false" as string naming dark field', () => {
    const theme = cloneTheme('claude-light')
    theme.dark = 'false'
    const error = assertRejected(theme, /dark/, 'dark = "false"')
    assert.match(error, /dark/)
  })

  it('rejects "true" as string', () => {
    const theme = cloneTheme('claude-dark')
    theme.dark = 'true'
    assertRejected(theme, /dark/, 'dark = "true"')
  })

  it('rejects other non-boolean types for dark', () => {
    for (const val of [0, 1, null, [], {}, 'si', 'no', 'yes']) {
      const theme = cloneTheme('claude-light')
      theme.dark = val
      assertRejected(theme, /dark/, `dark = ${JSON.stringify(val)}`)
    }
  })

  it('accepts genuine booleans true and false', () => {
    const dark = cloneTheme('claude-light')
    dark.dark = true
    assert.equal(assertAccepted(dark, 'dark = true').dark, true)

    const light = cloneTheme('claude-dark')
    light.dark = false
    assert.equal(assertAccepted(light, 'dark = false').dark, false)
  })

  it('theme omitting dark defaults to dark: true as fallback', () => {
    const theme = cloneTheme('claude-light')
    delete theme.dark
    assert.equal(assertAccepted(theme, 'dark omitted').dark, true)
  })
})

describe('built-in themes: invariants', () => {
  it('every built-in theme passes validateTheme', () => {
    for (const theme of BUILTIN_THEMES) {
      const { theme: valid, error } = validateTheme(theme)
      assert.equal(error, null, `built-in theme "${theme.id}" rejected: ${error}`)
      assert.ok(valid, `built-in theme "${theme.id}" missing output`)
    }
  })

  it('every theme contains exactly 16 6-digit hex ANSI colors', () => {
    for (const theme of BUILTIN_THEMES) {
      const ansi = theme.terminal.ansi
      assert.ok(Array.isArray(ansi), `${theme.id}: ansi is not an array`)
      assert.equal(ansi.length, 16, `${theme.id}: ansi length ${ansi.length} instead of 16`)
      ansi.forEach((color, i) => {
        assert.match(color, /^#[0-9a-fA-F]{6}$/, `${theme.id}: ansi[${i}] = ${JSON.stringify(color)}`)
      })
    }
  })

  it('all 16 ANSI colors are unique', () => {
    for (const theme of BUILTIN_THEMES) {
      const seen = new Map<string, number>()
      theme.terminal.ansi.forEach((color, i) => {
        const key = color.toLowerCase()
        const first = seen.get(key)
        assert.equal(first, undefined, `${theme.id}: ansi[${i}] duplicates ansi[${first}] (${color})`)
        seen.set(key, i)
      })
    }
  })

  it('all ui and terminal colors are hex codes', () => {
    for (const theme of BUILTIN_THEMES) {
      for (const key of UI_KEYS) {
        assert.match(theme.ui[key], /^#[0-9a-fA-F]{3,8}$/, `${theme.id}: ui.${key}`)
      }
      for (const key of TERM_KEYS) {
        assert.match(theme.terminal[key], /^#[0-9a-fA-F]{3,8}$/, `${theme.id}: terminal.${key}`)
      }
    }
  })

  it('theme IDs are unique', () => {
    const seen = new Set<string>()
    for (const theme of BUILTIN_THEMES) {
      assert.ok(!seen.has(theme.id), `duplicate theme id: ${theme.id}`)
      seen.add(theme.id)
    }
  })

  it('every theme has non-empty name and boolean dark', () => {
    for (const theme of BUILTIN_THEMES) {
      assert.ok(theme.name.trim().length > 0, `${theme.id}: empty name`)
      assert.equal(typeof theme.dark, 'boolean', `${theme.id}: dark not a boolean`)
    }
  })

  it('no built-in theme is marked custom', () => {
    for (const theme of BUILTIN_THEMES) {
      assert.ok(!theme.custom, `${theme.id}: marked custom`)
      assert.equal(theme.source, undefined, `${theme.id}: has source file`)
    }
  })

  it('default theme ID exists in built-in list', () => {
    assert.ok(
      BUILTIN_THEMES.some((t) => t.id === DEFAULT_THEME_ID),
      `DEFAULT_THEME_ID "${DEFAULT_THEME_ID}" does not match any theme`
    )
  })

  it('includes at least one light theme and one dark theme', () => {
    assert.ok(BUILTIN_THEMES.some((t) => t.dark === false), 'no light theme')
    assert.ok(BUILTIN_THEMES.some((t) => t.dark === true), 'no dark theme')
  })
})

describe('validateTheme: non-theme values', () => {
  it('rejects values that are not objects', () => {
    for (const val of [null, undefined, '', 'claude-dark', 42, 0, true, false]) {
      const { theme, error } = validateTheme(val)
      assert.equal(theme, null, `${JSON.stringify(val)} accepted as theme`)
      assert.match(error ?? '', /object/, `${JSON.stringify(val)}: ambiguous error message`)
    }
  })

  it('rejects empty object specifying first missing field', () => {
    assertRejected({}, /id/, 'empty object')
  })

  it('rejects array passed instead of object', () => {
    assertRejected([], /id|object/, 'empty array')
    assertRejected([cloneTheme()], /id|object/, 'array containing theme')
  })
})

describe('validateTheme: missing required fields', () => {
  it('reports missing or invalid id', () => {
    for (const val of [undefined, '', 'Claude Dark', '-starts', 'with space', 'HELLO', 'à', 42, null]) {
      const theme = cloneTheme()
      if (val === undefined) delete theme.id
      else theme.id = val
      assertRejected(theme, /id/, `id = ${JSON.stringify(val)}`)
    }
  })

  it('reports missing or whitespace-only name', () => {
    for (const val of [undefined, '', '   ', '\t\n', 42, null, {}]) {
      const theme = cloneTheme()
      if (val === undefined) delete theme.name
      else theme.name = val
      assertRejected(theme, /name/, `name = ${JSON.stringify(val)}`)
    }
  })

  it('reports missing ui section', () => {
    for (const val of [undefined, null, 'light', 42, true]) {
      const theme = cloneTheme()
      if (val === undefined) delete theme.ui
      else theme.ui = val
      assertRejected(theme, /ui/, `ui = ${JSON.stringify(val)}`)
    }
  })

  it('reports missing terminal section', () => {
    for (const val of [undefined, null, 'dark', 42, true]) {
      const theme = cloneTheme()
      if (val === undefined) delete theme.terminal
      else theme.terminal = val
      assertRejected(theme, /terminal/, `terminal = ${JSON.stringify(val)}`)
    }
  })

  it('identifies missing individual ui key', () => {
    for (const key of UI_KEYS) {
      const theme = cloneTheme()
      delete ui(theme)[key]
      const error = assertRejected(theme, new RegExp(`ui\\.${key}\\b`), `missing ui.${key}`)
      assert.ok(error.includes(key), `message "${error}" does not name ${key}`)
    }
  })

  it('identifies missing individual terminal key', () => {
    for (const key of TERM_KEYS) {
      const theme = cloneTheme()
      delete terminal(theme)[key]
      assertRejected(theme, new RegExp(`terminal\\.${key}\\b`), `missing terminal.${key}`)
    }
  })

  it('rejects terminal missing ansi', () => {
    const theme = cloneTheme()
    delete terminal(theme).ansi
    assertRejected(theme, /ansi/, 'missing ansi')
  })
})

describe('validateTheme: color validation', () => {
  it('rejects non-hex color values in ui fields', () => {
    for (const val of INVALID_COLORS) {
      const theme = cloneTheme()
      ui(theme).text = val
      assertRejected(theme, /ui\.text\b/, `ui.text = ${JSON.stringify(val)}`)
    }
  })

  it('rejects non-hex color values in terminal fields', () => {
    for (const val of INVALID_COLORS) {
      const theme = cloneTheme()
      terminal(theme).background = val
      assertRejected(theme, /terminal\.background\b/, `terminal.background = ${JSON.stringify(val)}`)
    }
  })

  it('rejects invalid color in ansi array', () => {
    for (const val of INVALID_COLORS) {
      const theme = cloneTheme()
      const ansi = terminal(theme).ansi as unknown[]
      ansi[15] = val
      assertRejected(theme, /ansi/, `ansi[15] = ${JSON.stringify(val)}`)
    }
  })

  it('accepts legitimate hex color formats', () => {
    for (const color of ['#abc', '#ABC', '#aabbcc', '#AABBCC', '#aabbccdd']) {
      const theme = cloneTheme()
      ui(theme).text = color
      const res = assertAccepted(theme, `ui.text = ${color}`)
      assert.equal(res.ui.text, color)
    }
  })
})

describe('validateTheme: ansi palette must have exactly 16 colors', () => {
  it('rejects shorter array', () => {
    for (const n of [0, 1, 8, 15]) {
      const theme = cloneTheme()
      const ansi = terminal(theme).ansi as string[]
      terminal(theme).ansi = ansi.slice(0, n)
      assertRejected(theme, /ansi/, `ansi with ${n} items`)
    }
  })

  it('rejects longer array', () => {
    for (const n of [17, 20, 32]) {
      const theme = cloneTheme()
      const ansi = terminal(theme).ansi as string[]
      terminal(theme).ansi = [...ansi, ...Array(n - 16).fill('#ffffff')]
      assertRejected(theme, /ansi/, `ansi with ${n} items`)
    }
  })

  it('rejects non-array ansi', () => {
    for (const val of [null, '#ffffff', 16, {}, { 0: '#ffffff' }, true]) {
      const theme = cloneTheme()
      terminal(theme).ansi = val
      assertRejected(theme, /ansi/, `ansi = ${JSON.stringify(val)}`)
    }
  })

  it('rejects ansi with null item', () => {
    const theme = cloneTheme()
    const ansi = terminal(theme).ansi as unknown[]
    ansi[7] = null
    assertRejected(theme, /ansi/, 'ansi with 7th item null')
  })

  it('rejects sparse ansi array with missing index', () => {
    const theme = cloneTheme()
    const ansi = terminal(theme).ansi as unknown[]
    delete ansi[7]
    assertRejected(theme, /ansi/, 'ansi with 7th item missing')
  })

  it('accepts exactly 16 valid colors', () => {
    const theme = cloneTheme()
    terminal(theme).ansi = Array(16).fill('#123456')
    const res = assertAccepted(theme, 'ansi with 16 colors')
    assert.equal(res.terminal.ansi.length, 16)
  })
})

describe('validateTheme: returned object properties', () => {
  it('theme without source file is not marked custom', () => {
    const res = assertAccepted(cloneTheme(), 'without source')
    assert.equal(res.custom, false)
    assert.equal(res.source, undefined)
  })

  it('preserves source file path for custom theme', () => {
    const { theme, error } = validateTheme(cloneTheme(), 'C:\\themes\\my.json')
    assert.equal(error, null)
    assert.ok(theme)
    assert.equal(theme.custom, true)
    assert.equal(theme.source, 'C:\\themes\\my.json')
  })

  it('trims whitespace around name', () => {
    const theme = cloneTheme()
    theme.name = '  My Theme  '
    assert.equal(assertAccepted(theme, 'name with spaces').name, 'My Theme')
  })

  it('ignores invalid description type rather than rejecting theme', () => {
    for (const val of [42, null, {}, ['hello']]) {
      const theme = cloneTheme()
      theme.description = val
      assert.equal(
        assertAccepted(theme, `description = ${JSON.stringify(val)}`).description,
        undefined
      )
    }
  })

  it('preserves string description', () => {
    const theme = cloneTheme()
    theme.description = 'my palette'
    assert.equal(assertAccepted(theme, 'valid description').description, 'my palette')
  })

  it('preserves id, ui, and terminal colors without alteration', () => {
    const base = cloneTheme('gruvbox')
    const res = assertAccepted(base, 'cloned gruvbox')
    assert.equal(res.id, 'gruvbox')
    assert.deepEqual(res.ui, base.ui)
    assert.deepEqual(res.terminal, base.terminal)
  })
})

// --- Readability & Contrast -------------------------------------------------

function channelLuminance(v: number): number {
  const c = v / 255
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
}

function luminance(hex: string): number {
  let h = hex.slice(1)
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2]
  const r = parseInt(h.slice(0, 2), 16)
  const g = parseInt(h.slice(2, 4), 16)
  const b = parseInt(h.slice(4, 6), 16)
  return 0.2126 * channelLuminance(r) + 0.7152 * channelLuminance(g) + 0.0722 * channelLuminance(b)
}

function contrastRatio(a: string, b: string): number {
  const la = luminance(a)
  const lb = luminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

describe('readability: text and background contrast', () => {
  it('contrast ratio matches WCAG formula', () => {
    assert.equal(Number(contrastRatio('#000000', '#ffffff').toFixed(2)), 21)
    assert.equal(Number(contrastRatio('#ffffff', '#000000').toFixed(2)), 21)
    assert.equal(contrastRatio('#123456', '#123456'), 1)
    assert.equal(Number(contrastRatio('#777777', '#ffffff').toFixed(2)), 4.48)
    assert.equal(contrastRatio('#fff', '#000000'), contrastRatio('#ffffff', '#000000'))
  })

  it('main text exceeds 4.5:1 ratio on all theme backgrounds', () => {
    for (const theme of BUILTIN_THEMES) {
      for (const bg of ['desktop', 'panel', 'panelRaised'] as const) {
        const r = contrastRatio(theme.ui.text, theme.ui[bg])
        assert.ok(
          r >= 4.5,
          `${theme.id}: ui.text on ui.${bg} is ${r.toFixed(2)}:1, below AA threshold of 4.5:1`
        )
      }
      const term = contrastRatio(theme.terminal.foreground, theme.terminal.background)
      assert.ok(
        term >= 4.5,
        `${theme.id}: terminal ${term.toFixed(2)}:1, below AA threshold of 4.5:1`
      )
    }
  })

  it.skip('dim text exceeds 4.5:1 ratio', () => {
    for (const theme of BUILTIN_THEMES) {
      for (const bg of ['desktop', 'panel', 'panelRaised'] as const) {
        const r = contrastRatio(theme.ui.textDim, theme.ui[bg])
        assert.ok(
          r >= 4.5,
          `${theme.id}: ui.textDim on ui.${bg} is ${r.toFixed(2)}:1`
        )
      }
    }
  })

  it('ANSI black does not match terminal background', () => {
    for (const theme of BUILTIN_THEMES) {
      const r = contrastRatio(theme.terminal.ansi[0], theme.terminal.background)
      assert.ok(r > 1.01, `${theme.id}: ansi[0] on terminal background is ${r.toFixed(2)}:1`)
    }
  })
})
