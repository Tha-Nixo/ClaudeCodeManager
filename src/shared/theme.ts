/**
 * Theme definition format.
 *
 * A theme describes two things that must stay consistent with each other: the
 * app's interface and the terminal's ANSI colors. Keeping them in the same
 * file avoids the very visible case of a light frame around a dark terminal.
 *
 * It is also the format of personal themes: a JSON file of this shape in
 * %APPDATA%\claudemanager\themes\ is loaded at startup.
 */
export interface ThemeUi {
  /** Desktop canvas background behind panes. */
  desktop: string
  /** Background for panels and headers. */
  panel: string
  /** Background for raised/hover elements. */
  panelRaised: string
  /** Inactive pane border. */
  borderIdle: string
  /** Active pane border and accent color. */
  borderFocus: string
  text: string
  textDim: string
  accent: string
  ok: string
  waiting: string
  error: string
}

export interface ThemeTerminal {
  background: string
  foreground: string
  cursor: string
  selection: string
  /** 16 ANSI colors: 8 normal followed by 8 bright. */
  ansi: [
    string, string, string, string, string, string, string, string,
    string, string, string, string, string, string, string, string
  ]
}

export interface Theme {
  /** Stable identifier: it is what gets saved in the configuration. */
  id: string
  name: string
  /** Brief description shown in Settings. */
  description?: string
  /** Controls window shadow and page color-scheme. */
  dark: boolean
  ui: ThemeUi
  terminal: ThemeTerminal
  /** Present only on themes loaded from a file, to tell them apart in the UI. */
  custom?: boolean
  /** Source file path for error reporting. */
  source?: string
}

export interface ThemeLoadError {
  /** File name, not the full path: it is what the user sees. */
  file: string
  error: string
}

export interface ThemeCatalog {
  themes: Theme[]
  errors: ThemeLoadError[]
  /** Custom themes directory path shown in Settings. */
  directory: string
}

const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/

function isColor(value: unknown): value is string {
  return typeof value === 'string' && HEX.test(value)
}

const UI_KEYS: (keyof ThemeUi)[] = [
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
]

export interface ThemeValidation {
  theme: Theme | null
  /** Human-readable rejection reason displayed to user. */
  error: string | null
}

/**
 * Validates a theme loaded from a file. An incomplete theme is not "repaired"
 * with fallback values: half a theme applied is worse than a rejected one,
 * because it produces unreadable combinations without saying why.
 */
export function validateTheme(raw: unknown, source?: string): ThemeValidation {
  if (!raw || typeof raw !== 'object') return { theme: null, error: 'file does not contain an object' }
  const t = raw as Partial<Theme>

  if (typeof t.id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(t.id)) {
    return { theme: null, error: "missing or invalid 'id' (lowercase letters, digits, and hyphens)" }
  }
  if (typeof t.name !== 'string' || t.name.trim().length === 0) {
    return { theme: null, error: "missing 'name'" }
  }
  if (!t.ui || typeof t.ui !== 'object') return { theme: null, error: "missing 'ui' section" }
  if (!t.terminal || typeof t.terminal !== 'object') {
    return { theme: null, error: "missing 'terminal' section" }
  }

  // The cast goes through unknown because `t.ui` is still unverified data here:
  // it has the declared type but no guarantee that the fields are really there.
  const ui = t.ui as unknown as Record<string, unknown>
  for (const key of UI_KEYS) {
    if (!isColor(ui[key])) {
      return { theme: null, error: `ui.${key} missing or not a hex color` }
    }
  }

  const term = t.terminal as Partial<ThemeTerminal>
  for (const key of ['background', 'foreground', 'cursor', 'selection'] as const) {
    if (!isColor(term[key])) {
      return { theme: null, error: `terminal.${key} missing or not a hex color` }
    }
  }

  // `every` SKIPS positions never assigned, so an array with a hole
  // (`delete ansi[7]`) passed the check and reached xterm with an undefined
  // color. The explicit loop below looks at every position.
  if (!Array.isArray(term.ansi) || term.ansi.length !== 16) {
    return { theme: null, error: 'terminal.ansi must contain exactly 16 hex colors' }
  }
  for (let i = 0; i < 16; i++) {
    if (!isColor(term.ansi[i])) {
      return { theme: null, error: `terminal.ansi[${i}] missing or not a hex color` }
    }
  }

  // `dark` was the only field left unchecked: `"dark": "false"` with quotes too
  // many (a trivial JSON mistake) was enough for the string to differ from the
  // boolean false, and the light theme was applied as a dark one, with black
  // shadows on the light background and inverted scrollbars. Every other field
  // rejects a wrong type: this one must too.
  if (t.dark !== undefined && typeof t.dark !== 'boolean') {
    return { theme: null, error: 'dark must be boolean true or false, unquoted' }
  }

  return {
    theme: {
      id: t.id,
      name: t.name.trim(),
      description: typeof t.description === 'string' ? t.description : undefined,
      dark: t.dark !== false,
      ui: t.ui as ThemeUi,
      terminal: term as ThemeTerminal,
      custom: Boolean(source),
      source
    },
    error: null
  }
}
