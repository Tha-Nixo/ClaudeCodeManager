/**
 * Theme definition format.
 *
 * A theme configures both application UI styling and terminal ANSI palettes.
 * Storing both concurrently guarantees visual harmony between interface and terminal.
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
  /** Stable identifier saved in user config. */
  id: string
  name: string
  /** Brief description shown in Settings. */
  description?: string
  /** Controls window shadow and page color-scheme. */
  dark: boolean
  ui: ThemeUi
  terminal: ThemeTerminal
  /** Present on custom themes loaded from user directory. */
  custom?: boolean
  /** Source file path for error reporting. */
  source?: string
}

export interface ThemeLoadError {
  /** File basename displayed to user. */
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
 * Validates a theme loaded from disk. Themes with missing fields are rejected
 * rather than filled with fallback defaults to prevent unreadable color mismatches.
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

  if (!Array.isArray(term.ansi) || term.ansi.length !== 16) {
    return { theme: null, error: 'terminal.ansi must contain exactly 16 hex colors' }
  }
  for (let i = 0; i < 16; i++) {
    if (!isColor(term.ansi[i])) {
      return { theme: null, error: `terminal.ansi[${i}] missing or not a hex color` }
    }
  }

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
