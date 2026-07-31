import type { ITheme } from '@xterm/xterm'

/**
 * Tema ANSI di xterm, derivato dalla stessa palette di claude-dark.css.
 * I 16 colori sono desaturati verso il grigio caldo del fondo così che
 * l'output colorato di Claude Code non stoni con la cornice dell'app.
 */
export const claudeDarkXterm: ITheme = {
  background: '#1A1917',
  foreground: '#F0EEE6',
  cursor: '#D97757',
  cursorAccent: '#1A1917',
  selectionBackground: '#3E3C38',
  selectionForeground: '#F0EEE6',

  black: '#2B2A28',
  red: '#C15F3C',
  green: '#7DA87B',
  yellow: '#E0A458',
  blue: '#6E9CB8',
  magenta: '#A98BB5',
  cyan: '#79A8A0',
  white: '#D6D3C9',

  brightBlack: '#5C5A55',
  brightRed: '#D97757',
  brightGreen: '#96C293',
  brightYellow: '#EFBE77',
  brightBlue: '#8AB6D0',
  brightMagenta: '#C0A5CA',
  brightCyan: '#93C0B8',
  brightWhite: '#F0EEE6'
}
