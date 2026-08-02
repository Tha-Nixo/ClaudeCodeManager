import type { ITheme } from '@xterm/xterm'
import type { Theme } from '@shared/theme'
import { applyThemeToTerminals } from '../terminal/registry'

/**
 * Applica un tema all'app.
 *
 * Due destinatari, che vanno tenuti in sincrono: le variabili CSS, da cui
 * dipende tutta l'interfaccia, e le istanze xterm già vive, che hanno il
 * proprio oggetto tema e non leggono il CSS.
 */

export function xtermThemeOf(theme: Theme): ITheme {
  const a = theme.terminal.ansi
  return {
    background: theme.terminal.background,
    foreground: theme.terminal.foreground,
    cursor: theme.terminal.cursor,
    cursorAccent: theme.terminal.background,
    selectionBackground: theme.terminal.selection,
    selectionForeground: theme.terminal.foreground,
    black: a[0],
    red: a[1],
    green: a[2],
    yellow: a[3],
    blue: a[4],
    magenta: a[5],
    cyan: a[6],
    white: a[7],
    brightBlack: a[8],
    brightRed: a[9],
    brightGreen: a[10],
    brightYellow: a[11],
    brightBlue: a[12],
    brightMagenta: a[13],
    brightCyan: a[14],
    brightWhite: a[15]
  }
}

export function applyTheme(theme: Theme): void {
  const root = document.documentElement
  const ui = theme.ui

  root.style.setProperty('--cm-desktop', ui.desktop)
  root.style.setProperty('--cm-panel', ui.panel)
  root.style.setProperty('--cm-panel-raised', ui.panelRaised)
  root.style.setProperty('--cm-terminal-bg', theme.terminal.background)
  root.style.setProperty('--cm-border-idle', ui.borderIdle)
  root.style.setProperty('--cm-border-focus', ui.borderFocus)
  root.style.setProperty('--cm-text', ui.text)
  root.style.setProperty('--cm-text-dim', ui.textDim)
  root.style.setProperty('--cm-accent', ui.accent)
  root.style.setProperty('--cm-ok', ui.ok)
  root.style.setProperty('--cm-waiting', ui.waiting)
  root.style.setProperty('--cm-error', ui.error)

  // Su un tema chiaro un'ombra nera pesante sporca invece di dare rilievo, e
  // il testo su fondo scuro dei pulsanti pieni diventa illeggibile.
  root.style.setProperty('--cm-shadow', theme.dark ? 'rgb(0 0 0 / 55%)' : 'rgb(60 50 40 / 18%)')
  root.style.setProperty('--cm-shadow-strong', theme.dark ? 'rgb(0 0 0 / 60%)' : 'rgb(60 50 40 / 26%)')
  root.style.setProperty('--cm-on-accent', theme.dark ? ui.desktop : '#FFFFFF')
  root.style.setProperty('--cm-overlay-veil', theme.dark ? 'rgb(15 14 13 / 62%)' : 'rgb(120 112 100 / 38%)')

  // Fa scegliere al sistema le barre di scorrimento e i controlli nativi
  // coerenti col tema, invece di lasciarli sempre scuri.
  root.style.setProperty('color-scheme', theme.dark ? 'dark' : 'light')
  root.dataset.theme = theme.id

  applyThemeToTerminals(xtermThemeOf(theme))
}
