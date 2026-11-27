import { Terminal, type ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { WebglAddon } from '@xterm/addon-webgl'
import '@xterm/xterm/css/xterm.css'
import { claudeDarkXterm } from '../theme/xterm-theme'

/** Value of a theme CSS variable, read at time of use. */
function readVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

/**
 * An xterm terminal instance, managed imperatively and intentionally OUTSIDE
 * React reconciliation: a React remount would destroy the buffer and
 * scroll history. React owns only the `<div>` mount slot in which
 * `element` is attached; the lifecycle of this object is managed by the
 * registry in `registry.ts`.
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
   * During layout animations, the container changes dimensions on every
   * frame. Measuring continuously would trigger a dozen pty.resize calls per
   * transition, causing Claude Code to redraw every time: we freeze
   * measurement and remeasure once when the transition concludes.
   */
  private fitSuspended = false

  private sessionId: string | null = null
  /** Keystrokes received before PTY exists: must be buffered, not lost. */
  private pendingInput: string[] = []
  private opened = false
  private disposed = false

  /** Title set by process via OSC sequence. */
  onTitle: ((title: string) => void) | null = null
  /** New dimensions in cells after fit. */
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
      // Informs xterm that ConPTY is on the other end: alters word-wrap
      // heuristics, preventing incorrect reflow after resize.
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

  /** Mounts terminal into provided React slot and observes resize events. */
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
   * Associates the terminal with a PTY session. Input forwarding begins;
   * any keystrokes buffered beforehand are sent immediately.
   */
  bind(sessionId: string): void {
    this.sessionId = sessionId
    if (this.pendingInput.length > 0) {
      const queued = this.pendingInput.join('')
      this.pendingInput = []
      window.cm.pty.write(sessionId, queued)
    }
    // PTY was created with estimated dimensions: align to actual terminal size.
    window.cm.pty.resize(sessionId, this.term.cols, this.term.rows)
  }

  write(data: string): void {
    if (!this.disposed) this.term.write(data)
  }

  /** Writes directly without passing through PTY: used for app messages inside pane. */
  writeAppMessage(text: string): void {
    this.write(`\r\n\x1b[38;2;140;139;135m${text}\x1b[0m\r\n`)
  }

  focus(): void {
    this.term.focus()
  }

  get dimensions(): { cols: number; rows: number } {
    return { cols: this.term.cols, rows: this.term.rows }
  }

  /** Immediately measures element. Call when mounted in DOM and visible. */
  fitNow(): { cols: number; rows: number } {
    try {
      this.fitAddon.fit()
    } catch {
      // Element may have zero dimensions during transition.
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

  /**
   * Searches scrollback and navigates view to match.
   *
   * Highlighting additional occurrences requires `decorations`, indicating
   * match counts without manual scrolling. Colors derive from the active
   * theme, avoiding illegible highlights on light backgrounds.
   */
  search(query: string, direction: 'next' | 'previous'): boolean {
    if (!query) {
      this.searchAddon.clearDecorations()
      return false
    }

    // Colors derive from variables guaranteed to exist in EVERY theme.
    // Adding new custom properties would break user themes: incomplete
    // themes are rejected rather than silently completed with fallbacks.
    const activeColor = readVar('--cm-accent') || '#d97757'
    const otherMatches = readVar('--cm-panel-raised') || '#2e2d2b'
    const rulerColor = readVar('--cm-text-dim') || '#949490'

    const options = {
      decorations: {
        matchBackground: otherMatches,
        matchBorder: rulerColor,
        matchOverviewRuler: rulerColor,
        activeMatchBackground: activeColor,
        activeMatchBorder: activeColor,
        activeMatchColorOverviewRuler: activeColor
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

  /** Freezes or resumes measurement; upon resumption, immediately remeasures. */
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
      // On WebGL context loss, xterm ceases rendering: dispose addon and
      // fall back to DOM renderer, which is slower but always available.
      addon.onContextLoss(() => {
        addon.dispose()
        this.webgl = null
      })
      this.term.loadAddon(addon)
      this.webgl = addon
    } catch {
      // WebGL2 unavailable: xterm remains on DOM renderer.
      this.webgl = null
    }
  }
}
