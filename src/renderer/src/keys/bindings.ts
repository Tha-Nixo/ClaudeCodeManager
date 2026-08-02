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
  | 'toggle-settings'
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
  'alt+,': 'toggle-settings',
  f11: 'toggle-fullscreen',
  f12: 'toggle-devtools',
  'ctrl+shift+q': 'quit'
}

/**
 * Azioni in ordine di presentazione, con la loro etichetta.
 *
 * L'ordine è quello dell'elenco nelle impostazioni: raggruppato per
 * argomento, non alfabetico, perché chi cerca "sposta il fuoco" si aspetta di
 * trovarlo accanto agli altri movimenti.
 */
export const ACTION_LABELS: { action: Action; label: string }[] = [
  { action: 'new-session', label: 'Nuova sessione (selettore)' },
  { action: 'new-session-here', label: 'Nuova sessione nella stessa cartella' },
  { action: 'split-h', label: 'Nuova sessione affiancata' },
  { action: 'split-v', label: 'Nuova sessione impilata' },
  { action: 'close-pane', label: 'Chiudi il riquadro' },
  { action: 'toggle-float', label: 'Stacca o riaggancia il riquadro' },
  { action: 'toggle-zoom', label: 'Ingrandisci il riquadro' },
  { action: 'focus-left', label: 'Fuoco a sinistra' },
  { action: 'focus-right', label: 'Fuoco a destra' },
  { action: 'focus-up', label: 'Fuoco in alto' },
  { action: 'focus-down', label: 'Fuoco in basso' },
  { action: 'move-left', label: 'Sposta il riquadro a sinistra' },
  { action: 'move-right', label: 'Sposta il riquadro a destra' },
  { action: 'move-up', label: 'Sposta il riquadro in alto' },
  { action: 'move-down', label: 'Sposta il riquadro in basso' },
  { action: 'toggle-usage', label: 'Statistiche di utilizzo' },
  { action: 'toggle-settings', label: 'Impostazioni' },
  { action: 'toggle-fullscreen', label: 'Schermo intero' },
  { action: 'toggle-devtools', label: 'Strumenti di sviluppo' },
  { action: 'quit', label: 'Esci' }
]

/** Tutte le azioni note, per validare una mappa scritta a mano. */
const ACTIONS = new Set<string>(Object.values(DEFAULT_KEYMAP))

export interface KeymapProblem {
  combo: string
  reason: string
}

export interface ResolvedKeymap {
  keymap: Record<string, Action>
  /** Voci scartate, da mostrare in chiaro invece di ignorarle in silenzio. */
  problems: KeymapProblem[]
}

/**
 * Unisce le scorciatoie personalizzate a quelle predefinite.
 *
 * Si SOVRAPPONE invece di sostituire: chi vuole spostare una sola
 * combinazione non deve ridichiarare le altre venti. Una voce con azione
 * vuota TOGLIE la scorciatoia, che è l'unico modo di liberare una
 * combinazione senza rimpiazzarla — serve a chi vuole restituire `Alt+B` a
 * readline.
 *
 * Le voci non valide vengono scartate con la ragione, non completate con un
 * valore di ripiego: una scorciatoia che fa una cosa diversa da quella
 * scritta è peggio di una che non funziona.
 */
export function resolveKeymap(custom: Record<string, string> | undefined): ResolvedKeymap {
  const keymap: Record<string, Action> = { ...DEFAULT_KEYMAP }
  const problems: KeymapProblem[] = []

  for (const [rawCombo, action] of Object.entries(custom ?? {})) {
    const combo = normalizeCombo(rawCombo)
    if (!combo) {
      problems.push({ combo: rawCombo, reason: 'combinazione vuota' })
      continue
    }

    // Azione vuota = rimozione. Va gestita prima della validazione, perché
    // la stringa vuota non è un'azione valida.
    if (action === '') {
      delete keymap[combo]
      continue
    }

    if (!ACTIONS.has(action)) {
      problems.push({ combo, reason: `azione sconosciuta: ${action}` })
      continue
    }

    keymap[combo] = action as Action
  }

  return { keymap, problems }
}

/**
 * Riordina i modificatori nell'ordine canonico e normalizza il tasto.
 *
 * Senza questo `shift+alt+b` non corrisponderebbe mai a niente, perché la
 * firma prodotta dall'evento è sempre `alt+shift+b`: il file si scrive a
 * mano, e nessuno indovina l'ordine giusto al primo colpo.
 */
export function normalizeCombo(raw: string): string | null {
  const parts = raw
    .toLowerCase()
    .split('+')
    .map((p) => p.trim())
    .filter(Boolean)
  if (parts.length === 0) return null

  const key = parts[parts.length - 1]
  const mods = new Set(parts.slice(0, -1))
  const order = ['ctrl', 'alt', 'shift', 'meta'].filter((m) => mods.has(m))

  // Un modificatore sconosciuto in mezzo verrebbe scambiato per il tasto:
  // meglio rifiutare che produrre una combinazione plausibile e sbagliata.
  if (order.length !== mods.size) return null

  return [...order, key].join('+')
}
/** Come `signature`, ma per il solo tasto: `code` per lettere e cifre. */
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

/**
 * Nome del tasto indipendente dal layout: per lettere e cifre si usa `code`,
 * così Alt+B resta Alt+B anche su tastiere non QWERTY.
 */
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
