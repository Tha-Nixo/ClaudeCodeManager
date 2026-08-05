/**
 * Formato di un tema.
 *
 * Un tema descrive due cose che devono restare coerenti fra loro:
 * l'interfaccia dell'app e i colori ANSI del terminale. Tenerle nello stesso
 * file evita il caso, molto visibile, di una cornice chiara attorno a un
 * terminale scuro.
 *
 * È anche il formato dei temi personali: un file JSON in
 * %APPDATA%\claudemanager\themes\ con questa forma viene caricato all'avvio.
 */

export interface ThemeUi {
  /** Sfondo del desktop, dietro i riquadri. */
  desktop: string
  /** Sfondo di pannelli e intestazioni. */
  panel: string
  /** Sfondo di elementi in rilievo (hover, riga attiva). */
  panelRaised: string
  /** Bordo di un riquadro non attivo. */
  borderIdle: string
  /** Bordo del riquadro attivo, e colore di accento. */
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
  /** I 16 colori ANSI, nell'ordine standard: 8 normali poi 8 brillanti. */
  ansi: [
    string, string, string, string, string, string, string, string,
    string, string, string, string, string, string, string, string
  ]
}

export interface Theme {
  /** Identificatore stabile: è ciò che viene salvato nella configurazione. */
  id: string
  name: string
  /** Descrizione breve mostrata accanto al nome nelle impostazioni. */
  description?: string
  /** Determina l'ombra dei riquadri e il color-scheme della pagina. */
  dark: boolean
  ui: ThemeUi
  terminal: ThemeTerminal
  /** Presente solo sui temi caricati da file, per distinguerli nella UI. */
  custom?: boolean
  /** Percorso del file di origine, per poterlo mostrare in caso di errore. */
  source?: string
}

export interface ThemeLoadError {
  /** Nome del file, non il percorso completo: è quello che l'utente vede. */
  file: string
  error: string
}

export interface ThemeCatalog {
  themes: Theme[]
  errors: ThemeLoadError[]
  /** Cartella dei temi personali, mostrata nelle impostazioni. */
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
  /** Motivo leggibile del rifiuto, da mostrare all'utente. */
  error: string | null
}

/**
 * Valida un tema arrivato da file. Un tema incompleto non viene "riparato"
 * con valori di ripiego: mezzo tema applicato è peggio di un tema rifiutato,
 * perché produce combinazioni illeggibili senza dire perché.
 */
export function validateTheme(raw: unknown, source?: string): ThemeValidation {
  if (!raw || typeof raw !== 'object') return { theme: null, error: 'il file non contiene un oggetto' }
  const t = raw as Partial<Theme>

  if (typeof t.id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(t.id)) {
    return { theme: null, error: "'id' mancante o non valido (minuscole, cifre e trattini)" }
  }
  if (typeof t.name !== 'string' || t.name.trim().length === 0) {
    return { theme: null, error: "'name' mancante" }
  }
  if (!t.ui || typeof t.ui !== 'object') return { theme: null, error: "sezione 'ui' mancante" }
  if (!t.terminal || typeof t.terminal !== 'object') {
    return { theme: null, error: "sezione 'terminal' mancante" }
  }

  // Il cast passa da unknown perché qui `t.ui` è ancora dato non verificato:
  // ha il tipo dichiarato ma non la garanzia che i campi ci siano davvero.
  const ui = t.ui as unknown as Record<string, unknown>
  for (const key of UI_KEYS) {
    if (!isColor(ui[key])) {
      return { theme: null, error: `ui.${key} mancante o non è un colore esadecimale` }
    }
  }

  const term = t.terminal as Partial<ThemeTerminal>
  for (const key of ['background', 'foreground', 'cursor', 'selection'] as const) {
    if (!isColor(term[key])) {
      return { theme: null, error: `terminal.${key} mancante o non è un colore esadecimale` }
    }
  }
  // `every` SALTA le posizioni mai assegnate, quindi un array con un buco
  // (`delete ansi[7]`, o un JSON con una virgola di troppo) passava il
  // controllo e arrivava fino a xterm con un colore indefinito. Il ciclo
  // esplicito guarda ogni posizione.
  if (!Array.isArray(term.ansi) || term.ansi.length !== 16) {
    return { theme: null, error: 'terminal.ansi deve contenere esattamente 16 colori esadecimali' }
  }
  for (let i = 0; i < 16; i++) {
    if (!isColor(term.ansi[i])) {
      return { theme: null, error: `terminal.ansi[${i}] mancante o non è un colore esadecimale` }
    }
  }

  // `dark` era l'unico campo non controllato: bastava `"dark": "false"` con le
  // virgolette di troppo — errore banale in JSON — perché la stringa risultasse
  // diversa dal booleano false e il tema chiaro venisse applicato come scuro,
  // con ombre nere sul fondo chiaro e barre di scorrimento invertite. Tutti gli
  // altri campi rifiutano un tipo sbagliato: anche questo deve farlo.
  if (t.dark !== undefined && typeof t.dark !== 'boolean') {
    return { theme: null, error: 'dark deve essere true o false, senza virgolette' }
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
