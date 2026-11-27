/**
 * Compositor keybindings.
 *
 * Golden rule: the compositor intercepts ONLY the combinations in the map.
 * Everything else reaches the terminal intact, and with it Claude Code.
 *
 * On an Italian keyboard AltGr generates ctrlKey AND altKey together (needed
 * for @, #, [, ], {, }). Since the signature always includes every modifier,
 * AltGr+ù produces 'ctrl+alt+…', which is not in the map and passes through:
 * no character is ever taken away from whoever is typing.
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
  | 'search-pane'
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
  // 'b' = side-by-side (horizontal split), 'v' = stacked (vertical split)
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

  // 's' = search. Remappable: users who use Alt+S in readline can rebind or unbind in settings.
  'alt+s': 'search-pane',

  'alt+u': 'toggle-usage',
  'alt+,': 'toggle-settings',
  f11: 'toggle-fullscreen',
  f12: 'toggle-devtools',
  'ctrl+shift+q': 'quit'
}

/**
 * Actions in presentation order, with their labels.
 *
 * The order is the one of the list in Settings: grouped by topic, not
 * alphabetical, because whoever looks for "move focus" expects to find it
 * next to the other movements.
 */
export const ACTION_LABELS: { action: Action; label: string }[] = [
  { action: 'new-session', label: 'New session (picker)' },
  { action: 'new-session-here', label: 'New session in current directory' },
  { action: 'split-h', label: 'New split session (horizontal)' },
  { action: 'split-v', label: 'New split session (vertical)' },
  { action: 'close-pane', label: 'Close pane' },
  { action: 'toggle-float', label: 'Toggle float / dock pane' },
  { action: 'toggle-zoom', label: 'Toggle zoom pane' },
  { action: 'focus-left', label: 'Focus left' },
  { action: 'focus-right', label: 'Focus right' },
  { action: 'focus-up', label: 'Focus up' },
  { action: 'focus-down', label: 'Focus down' },
  { action: 'move-left', label: 'Move pane left' },
  { action: 'move-right', label: 'Move pane right' },
  { action: 'move-up', label: 'Move pane up' },
  { action: 'move-down', label: 'Move pane down' },
  // The nine numeric shortcuts were missing from this list: they did not show
  // up in the panel, so they could not be discovered, remapped or freed, and
  // reassigning Alt+1 left focus-on-pane-1 without a key with no row to reveal
  // it.
  { action: 'focus-1', label: 'Focus pane 1' },
  { action: 'focus-2', label: 'Focus pane 2' },
  { action: 'focus-3', label: 'Focus pane 3' },
  { action: 'focus-4', label: 'Focus pane 4' },
  { action: 'focus-5', label: 'Focus pane 5' },
  { action: 'focus-6', label: 'Focus pane 6' },
  { action: 'focus-7', label: 'Focus pane 7' },
  { action: 'focus-8', label: 'Focus pane 8' },
  { action: 'focus-9', label: 'Focus pane 9' },
  { action: 'search-pane', label: 'Search terminal' },
  { action: 'toggle-usage', label: 'Usage statistics' },
  { action: 'toggle-settings', label: 'Settings' },
  { action: 'toggle-fullscreen', label: 'Fullscreen' },
  { action: 'toggle-devtools', label: 'Developer tools' },
  { action: 'quit', label: 'Quit' }
]

/**
 * Actions shown in the shortcut editor. Without DevTools (packaged builds,
 * #19) the "Developer tools" row would record a shortcut that does nothing.
 */
export function editableActions(devTools: boolean): { action: Action; label: string }[] {
  return devTools ? ACTION_LABELS : ACTION_LABELS.filter((a) => a.action !== 'toggle-devtools')
}

/** Every known action, to validate a hand-written map. */
const ACTIONS = new Set<string>(Object.values(DEFAULT_KEYMAP))

export interface KeymapProblem {
  combo: string
  reason: string
}

export interface ResolvedKeymap {
  keymap: Record<string, Action>
  /** Rejected entries, to be shown plainly instead of silently ignored. */
  problems: KeymapProblem[]
}

/**
 * Merges the custom shortcuts with the default ones.
 *
 * It OVERLAYS instead of replacing: whoever wants to move a single combination
 * must not redeclare the other twenty. An entry with an empty action REMOVES
 * the shortcut, which is the only way to free a combination without replacing
 * it: it is what gives `Alt+B` back to readline.
 *
 * Invalid entries are dropped with a reason, not completed with a fallback
 * value: a shortcut that does something other than what was written is worse
 * than one that does not work.
 *
 * With `devTools: false` (packaged builds, #19) every combination bound to
 * `toggle-devtools` is dropped, default or custom, so the key reaches the
 * terminal instead of being swallowed by an action that cannot run.
 */
export function resolveKeymap(
  custom: Record<string, string> | undefined,
  { devTools = true }: { devTools?: boolean } = {}
): ResolvedKeymap {
  const keymap: Record<string, Action> = { ...DEFAULT_KEYMAP }
  const problems: KeymapProblem[] = []

  for (const [rawCombo, action] of Object.entries(custom ?? {})) {
    const combo = normalizeCombo(rawCombo)
    if (!combo) {
      // The reason must be told apart: saying "empty combination" to whoever wrote
      // `super+b` sends them looking for the problem where it is not.
      problems.push({
        combo: rawCombo,
        reason: rawCombo.trim() === '' ? 'empty combination' : 'invalid modifier or key'
      })
      continue
    }

    // Empty action = removal. It is handled before validation, because the empty
    // string is not a valid action.
    if (action === '') {
      delete keymap[combo]
      continue
    }

    if (!ACTIONS.has(action)) {
      problems.push({ combo, reason: `unknown action: ${action}` })
      continue
    }

    keymap[combo] = action as Action
  }

  if (!devTools) {
    for (const [combo, action] of Object.entries(keymap)) {
      if (action === 'toggle-devtools') delete keymap[combo]
    }
  }

  return { keymap, problems }
}

/**
 * Puts the modifiers in canonical order and normalizes the key.
 *
 * Without this, `shift+alt+b` would never match anything, because the
 * signature produced by the event is always `alt+shift+b`: the file is written
 * by hand, and nobody guesses the right order the first time.
 */
export function normalizeCombo(raw: string): string | null {
  const text = raw.toLowerCase()

  // An empty string is not a combination. Without this check it was read as
  // "the + key", and an empty key in the configuration file silently bound '+'
  // to an action, taking it away from the terminal.
  if (text === '') return null

  // The key is split off at the LAST '+', not with a split on all of them.
  // `split('+')` followed by `filter(Boolean)` used to drop exactly the '+' and
  // space keys, and the last remaining modifier was taken for the key: whoever
  // assigned Alt+Space lost the old shortcut, did not get a new one, and the app
  // showed "Alt" as the assigned key.
  const splitIdx = text.lastIndexOf('+')

  // A '+' in last position means the key is '+' itself.
  const rawKey = splitIdx === -1 ? text : text.slice(splitIdx + 1)
  const modifiers = splitIdx === -1 ? '' : text.slice(0, splitIdx)

  // Space is a legitimate key, so surrounding whitespace is trimmed only when
  // something is left: `alt + b` written with spaces must keep working.
  const key = rawKey.trim() || (rawKey === '' ? '+' : rawKey)
  if (!key) return null

  const mods = new Set(
    modifiers
      .split('+')
      .map((p) => p.trim())
      .filter(Boolean)
  )
  const order = ['ctrl', 'alt', 'shift', 'meta'].filter((m) => mods.has(m))

  // An unknown modifier in the middle would be taken for the key: better to
  // reject than to produce a plausible, wrong combination.
  if (order.length !== mods.size) return null

  return [...order, key].join('+')
}

/** Like `signature`, but for the key alone: `code` for letters and digits. */
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
 * Layout-independent key name: letters and digits use `code`, so Alt+B stays
 * Alt+B even on non-QWERTY keyboards.
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

/** Returns a user-friendly display string for a key combination. */
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
          return 'Enter'
        // Without a name, "Alt+ " on screen reads "Alt+" and looks like a truncated
        // shortcut instead of one assigned to the space bar.
        case ' ':
          return 'Space'
        case 'escape':
          return 'Esc'
        default:
          return part.length === 1 ? part.toUpperCase() : part.toUpperCase()
      }
    })
    .join('+')
}

/** Returns the first key combination bound to an action for tooltips. */
export function keyForAction(action: Action, keymap = DEFAULT_KEYMAP): string | null {
  const entry = Object.entries(keymap).find(([, a]) => a === action)
  return entry ? prettyKey(entry[0]) : null
}

export interface KeyHandlerOptions {
  keymap?: Readonly<Record<string, Action>>
  /** When false, no shortcuts are intercepted (e.g. modal overlay open). */
  isEnabled: () => boolean
  onAction: (action: Action) => void
}

/**
 * Registers the listener in the CAPTURE phase on window: it intercepts before
 * xterm sees the event. Combinations not in the map are left untouched, so
 * they go on to the terminal as usual.
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
