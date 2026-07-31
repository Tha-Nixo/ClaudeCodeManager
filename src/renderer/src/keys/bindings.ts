/**
 * Scorciatoie del compositor.
 *
 * Regola d'oro: il compositor intercetta SOLO le combinazioni presenti nella
 * mappa. Tutto il resto arriva intatto al terminale, e quindi a Claude Code.
 *
 * Su tastiera italiana AltGr genera ctrlKey E altKey insieme (serve per @, #,
 * [, ], {, }). Dato che la firma include sempre tutti i modificatori, un
 * AltGr+ù produce 'ctrl+alt+…' che non è in mappa e passa oltre: nessun
 * carattere viene mai sottratto a chi scrive.
 */

export type Action =
  | 'new-session'
  | 'new-session-here'
  | 'close-pane'
  | 'toggle-float'
  | 'toggle-zoom'
  | 'split-h'
  | 'split-v'
  | 'focus-left'
  | 'focus-right'
  | 'focus-up'
  | 'focus-down'
  | 'move-left'
  | 'move-right'
  | 'move-up'
  | 'move-down'
  | 'focus-1'
  | 'focus-2'
  | 'focus-3'
  | 'focus-4'
  | 'focus-5'
  | 'focus-6'
  | 'focus-7'
  | 'focus-8'
  | 'focus-9'
  | 'toggle-usage'
  | 'toggle-fullscreen'
  | 'toggle-devtools'
  | 'quit'

export const DEFAULT_KEYMAP: Readonly<Record<string, Action>> = {
  'alt+n': 'new-session',
  'alt+enter': 'new-session-here',
  'alt+w': 'close-pane',
  'alt+f': 'toggle-float',
  'alt+z': 'toggle-zoom',
  // 'b' = affiancati (blocchi a fianco), 'v' = impilati (uno sotto l'altro)
  'alt+b': 'split-h',
  'alt+v': 'split-v',

  'alt+left': 'focus-left',
  'alt+right': 'focus-right',
  'alt+up': 'focus-up',
  'alt+down': 'focus-down',

  'alt+shift+left': 'move-left',
  'alt+shift+right': 'move-right',
  'alt+shift+up': 'move-up',
  'alt+shift+down': 'move-down',

  'alt+1': 'focus-1',
  'alt+2': 'focus-2',
  'alt+3': 'focus-3',
  'alt+4': 'focus-4',
  'alt+5': 'focus-5',
  'alt+6': 'focus-6',
  'alt+7': 'focus-7',
  'alt+8': 'focus-8',
  'alt+9': 'focus-9',

  'alt+u': 'toggle-usage',
  f11: 'toggle-fullscreen',
  f12: 'toggle-devtools',
  'ctrl+shift+q': 'quit'
}

/**
 * Nome del tasto indipendente dal layout: per lettere e cifre si usa `code`,
 * così Alt+B resta Alt+B anche su tastiere non QWERTY.
 */
function normalizeKey(e: KeyboardEvent): string {
  if (/^Key[A-Z]$/.test(e.code)) return e.code.slice(3).toLowerCase()
  if (/^Digit[0-9]$/.test(e.code)) return e.code.slice(5)

  switch (e.key) {
    case 'ArrowLeft':
      return 'left'
    case 'ArrowRight':
      return 'right'
    case 'ArrowUp':
      return 'up'
    case 'ArrowDown':
      return 'down'
    case 'Enter':
      return 'enter'
    case 'Escape':
      return 'escape'
    default:
      return e.key.toLowerCase()
  }
}

export function signature(e: KeyboardEvent): string {
  const parts: string[] = []
  if (e.ctrlKey) parts.push('ctrl')
  if (e.altKey) parts.push('alt')
  if (e.shiftKey) parts.push('shift')
  if (e.metaKey) parts.push('meta')
  parts.push(normalizeKey(e))
  return parts.join('+')
}

/** Etichetta leggibile di una combinazione, per la UI. */
export function prettyKey(sig: string): string {
  return sig
    .split('+')
    .map((part) => {
      switch (part) {
        case 'ctrl':
          return 'Ctrl'
        case 'alt':
          return 'Alt'
        case 'shift':
          return 'Shift'
        case 'left':
          return '←'
        case 'right':
          return '→'
        case 'up':
          return '↑'
        case 'down':
          return '↓'
        case 'enter':
          return 'Invio'
        default:
          return part.length === 1 ? part.toUpperCase() : part.toUpperCase()
      }
    })
    .join('+')
}

/** Prima combinazione associata a un'azione, per mostrarla nei tooltip. */
export function keyForAction(action: Action, keymap = DEFAULT_KEYMAP): string | null {
  const entry = Object.entries(keymap).find(([, a]) => a === action)
  return entry ? prettyKey(entry[0]) : null
}

export interface KeyHandlerOptions {
  keymap?: Readonly<Record<string, Action>>
  /** Quando è false nessuna combinazione viene intercettata (es. overlay aperto). */
  isEnabled: () => boolean
  onAction: (action: Action) => void
}

/**
 * Registra l'ascoltatore in fase di CAPTURE su window: intercetta prima che
 * xterm veda l'evento. Le combinazioni non in mappa non vengono toccate, così
 * proseguono normalmente fino al terminale.
 */
export function installKeyHandler(options: KeyHandlerOptions): () => void {
  const keymap = options.keymap ?? DEFAULT_KEYMAP

  const onKeyDown = (e: KeyboardEvent): void => {
    if (!options.isEnabled()) return

    const action = keymap[signature(e)]
    if (!action) return

    e.preventDefault()
    e.stopPropagation()
    options.onAction(action)
  }

  window.addEventListener('keydown', onKeyDown, { capture: true })
  return () => window.removeEventListener('keydown', onKeyDown, { capture: true })
}
