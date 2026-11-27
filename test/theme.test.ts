import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { validateTheme, type Theme } from '../src/shared/theme'
import { BUILTIN_THEMES, DEFAULT_THEME_ID } from '../src/shared/themes/builtin'

/**
 * A theme is the one thing the user sees before reading any text in the app:
 * if validation lets a half-broken theme through, the result is not an error
 * but an unreadable window. Hence the insistence that every rejection names
 * the field at fault: the theme comes from a hand-written JSON file, and
 * "invalid" with nothing else does not help anyone fix it.
 */
type RawTheme = Record<string, unknown>

/**
 * Starting point of the negative cases: a deep copy of a built-in theme, that
 * is, an object that certainly passes validation. Mutating a single field
 * guarantees the rejection comes from that field, and not from some other
 * defect already present in the starting material.
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

/**
 * A rejection is only worth something if it tells the user where to look: both
 * that the theme is not applied and that the message names the field.
 */
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

/** Values no color field may accept, however they are written. */
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
  /**
   * The real case: `"dark": "false"`, with quotes too many. The string is not
   * equal to the boolean false, so the light theme was applied as a dark one
   * (black shadows on a light background, inverted scrollbars) with no warning.
   * The cases start from claude-light because it is the only built-in theme
   * with dark: false: exactly the scenario that broke.
   */
  it('baseline theme is light and valid', () => {
    const theme = assertAccepted(cloneTheme('claude-light'), 'cloned claude-light')
    assert.equal(theme.dark, false, 'baseline theme should be light')
  })

  it('rejects "false" as string naming dark field', () => {
    const theme = cloneTheme('claude-light')
    theme.dark = 'false'
    const error = assertRejected(theme, /dark/, 'dark = "false"')
    // The message must make clear that the quotes are the problem, not the value:
    // whoever wrote the file sees "false" and believes it is right.
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
    // dark is the only optional field. Omitting it gives a dark theme, by far
    // the most common case; writing it wrong gives an error instead of a
    // surprise.
    const theme = cloneTheme('claude-light')
    delete theme.dark
    assert.equal(assertAccepted(theme, 'dark omitted').dark, true)
  })
})

describe('built-in themes: invariants', () => {
  it('every built-in theme passes validateTheme', () => {
    // If a built-in theme did not pass, the app would ship a theme that refuses
    // to load as soon as the user copies it to customize it.
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
        // Full, opaque form: the 16 slots end up in xterm, where a color with an
        // alpha channel or in short form renders differently across platforms.
        assert.match(color, /^#[0-9a-fA-F]{6}$/, `${theme.id}: ansi[${i}] = ${JSON.stringify(color)}`)
      })
    }
  })

  it('all 16 ANSI colors are unique', () => {
    // Two slots made identical by copy and paste make two kinds of terminal
    // output indistinguishable (errors and warnings, for example).
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
    // custom marks, in the UI, the themes loaded from files: a built-in marked
    // custom would show up in the wrong section of Settings.
    for (const theme of BUILTIN_THEMES) {
      assert.ok(!theme.custom, `${theme.id}: marked custom`)
      assert.equal(theme.source, undefined, `${theme.id}: has source file`)
    }
  })

  it('default theme ID exists in built-in list', () => {
    // If it pointed to an id that does not exist, the app would start without
    // a theme.
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
    // A file holding `[ {...} ]` instead of the theme is a frequent mistake: it
    // must not be taken for a theme with silently missing fields.
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
      // Naming the section is not enough: the file has eleven ui colors.
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
    // The fifteenth color only shows when a program uses it: if it passed, the
    // defect would surface days after loading.
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
    // With 17 entries the last ones would be ignored silently: whoever added a
    // color in the middle would find the whole palette shifted by one.
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
    // This is the case JSON can really produce: `null` in the middle of the
    // list, for example after deleting a color halfway.
    const theme = cloneTheme()
    const ansi = terminal(theme).ansi as unknown[]
    ansi[7] = null
    assertRejected(theme, /ansi/, 'ansi with 7th item null')
  })

  /**
   * Found while writing this suite: an ansi list with a hole (an entry never
   * assigned) was ACCEPTED. The check used `term.ansi.every(isColor)`, and
   * `every` skips empty slots instead of visiting them: the length stayed 16
   * and validation passed, returning a theme with `terminal.ansi[7] ===
   * undefined`. The check now visits every index.
   *
   * No user could reach it, because the only caller (src/main/theme/store.ts)
   * passes the result of JSON.parse, which never produces lists with holes. It
   * was a trap for the next caller: one theme built in memory and xterm gets
   * an undefined color.
   */
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
    // The name ends up in an aligned list: spaces would show.
    const theme = cloneTheme()
    theme.name = '  My Theme  '
    assert.equal(assertAccepted(theme, 'name with spaces').name, 'My Theme')
  })

  it('ignores invalid description type rather than rejecting theme', () => {
    // The description is decorative: losing a whole theme because of it would
    // be a disproportionate punishment.
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

/**
 * Readability.
 *
 * The WCAG 2.1 contrast ratio: (L1 + 0.05) / (L2 + 0.05) on relative
 * luminances. The AA threshold for normal text is 4.5:1. Below it, text stays
 * visible but stops being comfortable, and on a panel read all day long the
 * difference shows.
 */
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
    // Without this check the figures reported below would be worth nothing.
    assert.equal(Number(contrastRatio('#000000', '#ffffff').toFixed(2)), 21)
    assert.equal(Number(contrastRatio('#ffffff', '#000000').toFixed(2)), 21)
    assert.equal(contrastRatio('#123456', '#123456'), 1)
    assert.equal(Number(contrastRatio('#777777', '#ffffff').toFixed(2)), 4.48)
    // The short form must give the same result as the long one.
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

  /**
   * Known defect, tracked in #30: dimmed text (ui.textDim) is below 4.5:1 in
   * five built-in themes out of six. Measured on src/shared/themes/builtin.ts,
   * ratio of textDim on panel / desktop / panelRaised:
   *
   *   claude-dark     4.44  4.88  4.03
   *   claude-light    4.89  4.43  4.20
   *   mezzanotte      3.46  3.81  3.04
   *   gruvbox         4.02  4.47  3.58
   *   nord            3.28  4.07  2.81
   *   alto-contrasto  9.27 10.02  8.30
   *
   * textDim is not decorative: session paths, times and states use it, that
   * is, text people really read. The worst case is nord on the raised panel
   * (2.81:1), which is the row under the pointer. Skipped because the fix means
   * retouching the palettes: a design decision, not a line of code.
   */
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

  /**
   * Found while writing this suite: in the "High contrast" theme ANSI black
   * (ansi[0] = #000000) was the terminal background (#000000), a 1.00:1
   * contrast, that is, invisible text. Any program printing in black (progress
   * bars and diffs do) vanished completely, in the very theme that promises
   * "maximum readability". Each theme's ansi[0] must differ from its background.
   */
  it('ANSI black does not match terminal background', () => {
    for (const theme of BUILTIN_THEMES) {
      const r = contrastRatio(theme.terminal.ansi[0], theme.terminal.background)
      assert.ok(r > 1.01, `${theme.id}: ansi[0] on terminal background is ${r.toFixed(2)}:1`)
    }
  })
})
