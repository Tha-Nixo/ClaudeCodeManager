import { Terminal, type ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { WebglAddon } from '@xterm/addon-webgl'
import '@xterm/xterm/css/xterm.css'
import { claudeDarkXterm } from '../theme/xterm-theme'

/** Valore di una variabile CSS del tema, letto al momento dell'uso. */
function readVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

/**
 * Un terminale xterm, gestito imperativamente e volutamente FUORI dalla
 * riconciliazione di React: un remount di React distruggerebbe il buffer e
 * la history di scorrimento. React possiede solo il `<div>` slot in cui
 * innestiamo `element`; il ciclo di vita di questo oggetto lo decide il
 * registro in `registry.ts`.
 */
export class TerminalHost {
  readonly element: HTMLDivElement

  private readonly term: Terminal
  private readonly fitAddon = new FitAddon()
  private readonly searchAddon = new SearchAddon()
  private webgl: WebglAddon | null = null
  private observer: ResizeObserver | null = null
  private fitFrame = 0

  /**
   * Durante un'animazione di layout il contenitore cambia dimensione a ogni
   * frame. Rimisurare significherebbe una dozzina di pty.resize per
   * transizione, con Claude Code che ridisegna ogni volta: si congela la
   * misura e si rimisura una sola volta alla fine.
   */
  private fitSuspended = false

  private sessionId: string | null = null
  /** Tasti premuti prima che il PTY esista: vanno consegnati, non persi. */
  private pendingInput: string[] = []
  private opened = false
  private disposed = false

  /** Titolo impostato dal processo via sequenza OSC. */
  onTitle: ((title: string) => void) | null = null
  /** Nuove dimensioni in celle dopo un fit. */
  onResize: ((dims: { cols: number; rows: number }) => void) | null = null

  constructor(theme?: ITheme) {
    this.element = document.createElement('div')
    this.element.className = 'cm-term'

    this.term = new Terminal({
      allowProposedApi: true,
      cursorBlink: true,
      cursorStyle: 'bar',
      fontFamily: "'Cascadia Code', 'Cascadia Mono', Consolas, 'Courier New', monospace",
      fontSize: 13,
      lineHeight: 1.15,
      letterSpacing: 0,
      scrollback: 10000,
      theme: theme ?? claudeDarkXterm,
      // Dice a xterm che dall'altra parte c'è ConPTY: cambia le euristiche di
      // riavvolgimento riga, altrimenti il riflow dopo un resize è sbagliato.
      windowsPty: { backend: 'conpty' }
    })

    this.term.onData((data) => this.sendInput(data))
    this.term.onBinary((data) => this.sendInput(data))
    this.term.onTitleChange((title) => this.onTitle?.(title))
    this.term.onResize(({ cols, rows }) => {
      if (this.sessionId) window.cm.pty.resize(this.sessionId, cols, rows)
      this.onResize?.({ cols, rows })
    })
  }

  /** Innesta il terminale nello slot fornito da React e inizia a osservarlo. */
  attach(parent: HTMLElement): void {
    if (this.disposed) return
    if (this.element.parentElement !== parent) parent.appendChild(this.element)

    if (!this.opened) {
      this.term.open(this.element)
      this.term.loadAddon(this.fitAddon)
      this.term.loadAddon(this.searchAddon)
      this.term.loadAddon(new WebLinksAddon())
      this.enableWebgl()
      this.opened = true
    }

    this.observer ??= new ResizeObserver(() => this.scheduleFit())
    this.observer.observe(this.element)
    this.scheduleFit()
  }

  detach(): void {
    this.observer?.disconnect()
    this.observer = null
    this.element.remove()
  }

  /**
   * Associa il terminale a un PTY. Da questo momento l'input viene inoltrato;
   * quanto digitato prima viene consegnato subito.
   */
  bind(sessionId: string): void {
    this.sessionId = sessionId
    if (this.pendingInput.length > 0) {
      const queued = this.pendingInput.join('')
      this.pendingInput = []
      window.cm.pty.write(sessionId, queued)
    }
    // Il PTY è nato con dimensioni stimate: allineiamolo a quelle reali.
    window.cm.pty.resize(sessionId, this.term.cols, this.term.rows)
  }

  write(data: string): void {
    if (!this.disposed) this.term.write(data)
  }

  /** Scrive senza passare dal PTY: per messaggi dell'app dentro il riquadro. */
  writeAppMessage(text: string): void {
    this.write(`\r\n\x1b[38;2;140;139;135m${text}\x1b[0m\r\n`)
  }

  focus(): void {
    this.term.focus()
  }

  get dimensions(): { cols: number; rows: number } {
    return { cols: this.term.cols, rows: this.term.rows }
  }

  /** Misura subito l'elemento. Da chiamare quando è già nel DOM e visibile. */
  fitNow(): { cols: number; rows: number } {
    try {
      this.fitAddon.fit()
    } catch {
      // L'elemento può essere a dimensione zero durante una transizione.
    }
    return this.dimensions
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (this.fitFrame) cancelAnimationFrame(this.fitFrame)
    this.observer?.disconnect()
    this.observer = null
    this.webgl?.dispose()
    this.term.dispose()
    this.element.remove()
  }

  private sendInput(data: string): void {
    if (this.sessionId) window.cm.pty.write(this.sessionId, data)
    else this.pendingInput.push(data)
  }

  /** Cambia la tavolozza del terminale senza toccarne il contenuto. */
  /**
   * Cerca nello scrollback e porta la vista sulla corrispondenza.
   *
   * L'evidenziazione delle altre occorrenze richiede `decorations`, che
   * servono a capire quante ce ne sono senza scorrere a mano. I colori
   * arrivano dal tema attivo, altrimenti su un tema chiaro l'evidenziazione
   * predefinita di xterm sparisce nel fondo.
   */
  search(query: string, direction: 'next' | 'previous'): boolean {
    if (!query) {
      this.searchAddon.clearDecorations()
      return false
    }

    // I colori vengono da variabili che OGNI tema ha già. Aggiungerne una
    // nuova al formato romperebbe i temi personali esistenti: un tema
    // incompleto viene rifiutato, non completato con valori di ripiego.
    const attivo = readVar('--cm-accent') || '#d97757'
    const altre = readVar('--cm-panel-raised') || '#2e2d2b'
    const righello = readVar('--cm-text-dim') || '#8c8b87'

    const options = {
      decorations: {
        matchBackground: altre,
        matchBorder: righello,
        matchOverviewRuler: righello,
        activeMatchBackground: attivo,
        activeMatchBorder: attivo,
        activeMatchColorOverviewRuler: attivo
      }
    }

    return direction === 'next'
      ? this.searchAddon.findNext(query, options)
      : this.searchAddon.findPrevious(query, options)
  }

  clearSearch(): void {
    this.searchAddon.clearDecorations()
  }

  setTheme(theme: ITheme): void {
    if (this.disposed) return
    this.term.options.theme = theme
  }

  /** Congela o riprende la misurazione; alla ripresa rimisura subito. */
  setFitSuspended(suspended: boolean): void {
    if (this.fitSuspended === suspended) return
    this.fitSuspended = suspended
    if (!suspended) this.scheduleFit()
  }

  private scheduleFit(): void {
    if (this.fitFrame || this.disposed || this.fitSuspended) return
    this.fitFrame = requestAnimationFrame(() => {
      this.fitFrame = 0
      if (this.fitSuspended) return
      this.fitNow()
    })
  }

  private enableWebgl(): void {
    try {
      const addon = new WebglAddon()
      // Alla perdita del contesto WebGL xterm non ridisegna più nulla: si
      // scarica l'addon e si torna al renderer DOM, che è più lento ma sempre
      // disponibile.
      addon.onContextLoss(() => {
        addon.dispose()
        this.webgl = null
      })
      this.term.loadAddon(addon)
      this.webgl = addon
    } catch {
      // Nessun WebGL2 disponibile: xterm resta sul renderer DOM.
      this.webgl = null
    }
  }
}
