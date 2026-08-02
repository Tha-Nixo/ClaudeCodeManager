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
 * Temi disponibili: quelli integrati più i file JSON lasciati dall'utente in
 * %APPDATA%\claudemanager\themes\.
 *
 * Un file non valido non viene silenziosamente ignorato: l'errore viaggia
 * fino alle impostazioni, altrimenti chi ha scritto il tema non ha modo di
 * capire perché non compare.
 */

export function themesDir(): string {
  return join(app.getPath('userData'), 'themes')
}

/** Crea la cartella e ci lascia un esempio commentato la prima volta. */
export function ensureThemesDir(): string {
  const dir = themesDir()
  try {
    mkdirSync(dir, { recursive: true })
    const example = join(dir, 'esempio.json.txt')
    if (!existsSync(example)) {
      writeFileSync(example, EXAMPLE, 'utf8')
    }
  } catch {
    // Senza cartella restano i temi integrati: non è un errore fatale.
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
      raw = JSON.parse(readFileSync(full, 'utf8').replace(/^﻿/, ''))
    } catch (err) {
      errors.push({ file, error: `JSON non valido: ${err instanceof Error ? err.message : String(err)}` })
      continue
    }

    const { theme, error } = validateTheme(raw, full)
    if (!theme) {
      errors.push({ file, error: error ?? 'tema non valido' })
      continue
    }
    // Un tema personale può sostituire un integrato usandone l'id: è il modo
    // per ritoccare un tema esistente senza doverne inventare un altro.
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

const EXAMPLE = `Copia questo contenuto in un file con estensione .json in questa cartella
e comparira' fra i temi nelle impostazioni. Usando l'id di un tema integrato
(per esempio "claude-dark") lo si sostituisce invece di aggiungerne uno nuovo.

I colori sono esadecimali: #rgb, #rrggbb oppure #rrggbbaa.
"ansi" sono i 16 colori del terminale nell'ordine standard:
nero, rosso, verde, giallo, blu, magenta, ciano, bianco,
e poi le stesse otto tinte in versione brillante.

{
  "id": "mio-tema",
  "name": "Il mio tema",
  "description": "due parole che compaiono nelle impostazioni",
  "dark": true,
  "ui": {
    "desktop": "#1F1E1D",
    "panel": "#262625",
    "panelRaised": "#2E2D2B",
    "borderIdle": "#3A3937",
    "borderFocus": "#D97757",
    "text": "#F0EEE6",
    "textDim": "#8C8B87",
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
