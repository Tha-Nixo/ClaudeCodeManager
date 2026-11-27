import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import {
  validateTheme,
  type Theme,
  type ThemeCatalog,
  type ThemeLoadError
} from '@shared/theme'
import { BUILTIN_THEMES } from '@shared/themes/builtin'

/**
 * Available themes: built-in themes plus JSON files located in
 * %APPDATA%\claudemanager\themes\.
 */

export function themesDir(): string {
  return join(app.getPath('userData'), 'themes')
}

/** Ensures directory exists and seeds commented example on first launch. */
export function ensureThemesDir(): string {
  const dir = themesDir()
  try {
    mkdirSync(dir, { recursive: true })
    const example = join(dir, 'example.json.txt')
    if (!existsSync(example)) {
      writeFileSync(example, EXAMPLE, 'utf8')
    }
  } catch {
    // Falls back to built-in themes on filesystem error.
  }
  return dir
}

export function loadThemes(): ThemeCatalog {
  const dir = ensureThemesDir()
  const themes: Theme[] = [...BUILTIN_THEMES]
  const errors: ThemeLoadError[] = []
  const seen = new Set(themes.map((t) => t.id))

  let files: string[] = []
  try {
    files = readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.json'))
  } catch {
    files = []
  }

  for (const file of files.sort()) {
    const full = join(dir, file)
    let raw: unknown
    try {
      raw = JSON.parse(readFileSync(full, 'utf8').replace(/^\uFEFF/, ''))
    } catch (err) {
      errors.push({ file, error: `Invalid JSON: ${err instanceof Error ? err.message : String(err)}` })
      continue
    }

    const { theme, error } = validateTheme(raw, full)
    if (!theme) {
      errors.push({ file, error: error ?? 'invalid theme' })
      continue
    }
    // Custom theme overrides built-in theme if sharing matching ID.
    if (seen.has(theme.id)) {
      const index = themes.findIndex((t) => t.id === theme.id)
      themes[index] = theme
    } else {
      themes.push(theme)
      seen.add(theme.id)
    }
  }

  return { themes, errors, directory: dir }
}

export function findTheme(id: string): Theme {
  const { themes } = loadThemes()
  return themes.find((t) => t.id === id) ?? BUILTIN_THEMES[0]
}

const EXAMPLE = `Copy this content to a .json file in this directory to make it
appear in Settings. Using a built-in theme ID (e.g. "claude-dark")
overrides that theme instead of adding a new one.

Colors must be hexadecimal: #rgb, #rrggbb or #rrggbbaa.
"ansi" defines the 16 terminal colors in standard order:
black, red, green, yellow, blue, magenta, cyan, white,
followed by bright versions of the same eight colors.

{
  "id": "my-theme",
  "name": "My Theme",
  "description": "Short description shown in Settings",
  "dark": true,
  "ui": {
    "desktop": "#1F1E1D",
    "panel": "#262625",
    "panelRaised": "#2E2D2B",
    "borderIdle": "#3A3937",
    "borderFocus": "#D97757",
    "text": "#F0EEE6",
    "textDim": "#949490",
    "accent": "#D97757",
    "ok": "#7DA87B",
    "waiting": "#E0A458",
    "error": "#C15F3C"
  },
  "terminal": {
    "background": "#1A1917",
    "foreground": "#F0EEE6",
    "cursor": "#D97757",
    "selection": "#3E3C38",
    "ansi": [
      "#2B2A28", "#C15F3C", "#7DA87B", "#E0A458",
      "#6E9CB8", "#A98BB5", "#79A8A0", "#D6D3C9",
      "#5C5A55", "#D97757", "#96C293", "#EFBE77",
      "#8AB6D0", "#C0A5CA", "#93C0B8", "#F0EEE6"
    ]
  }
}
`
