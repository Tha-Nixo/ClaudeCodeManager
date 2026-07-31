import type { AppConfig, PersistedLayout, PersistedPane } from '@shared/types'
import { allPanes, type Layout, type LayoutNode } from '../compositor/layout'
import type { SessionMeta } from './types'

/**
 * Conversione fra lo stato vivo del compositor e la sua forma su disco.
 *
 * Il ripristino non è mai cieco: un layout.json scritto da una versione
 * precedente, o modificato a mano, non deve poter mandare l'app in uno stato
 * senza riquadri visibili.
 */

export function toPersisted(
  layout: Layout,
  sessions: Record<string, SessionMeta>
): PersistedLayout {
  const panes: PersistedPane[] = allPanes(layout)
    .map((paneId) => sessions[paneId])
    .filter((meta): meta is SessionMeta => Boolean(meta))
    .map((meta) => ({
      paneId: meta.paneId,
      cwd: meta.cwd,
      launch: meta.launch,
      claudeSessionId: meta.claudeSessionId ?? null
    }))

  return { version: 1, savedAt: Date.now(), tree: layout, panes }
}

export interface RestoreResult {
  layout: Layout
  sessions: Record<string, SessionMeta>
}

/**
 * Ricostruisce lo stato dal file salvato, scartando quello che non torna.
 * Ritorna null se non resta nulla di utilizzabile: chi chiama ricade
 * sull'apertura della sessione predefinita.
 */
export function fromPersisted(
  stored: PersistedLayout,
  config: AppConfig
): RestoreResult | null {
  if (!stored.panes?.length) return null

  const sessions: Record<string, SessionMeta> = {}
  for (const pane of stored.panes) {
    if (!pane.paneId || !pane.cwd) continue

    // Riprendere la conversazione precedente è la lettura utile di
    // "ripristina il layout": senza --resume si riaprirebbero riquadri vuoti
    // sulle cartelle giuste, che è molto meno di quanto promesso.
    const resume =
      config.restoreResumesSessions && pane.claudeSessionId ? pane.claudeSessionId : undefined

    sessions[pane.paneId] = {
      paneId: pane.paneId,
      cwd: pane.cwd,
      title: null,
      status: 'starting',
      claudeSessionId: pane.claudeSessionId ?? null,
      launch: { ...pane.launch, cwd: pane.cwd, resumeSessionId: resume }
    }
  }

  const known = new Set(Object.keys(sessions))
  if (known.size === 0) return null

  const layout = sanitizeLayout(stored.tree, known)
  if (!layout) return null

  // Un riquadro rimasto fuori dall'albero non sarebbe più raggiungibile:
  // meglio scartarne i metadati che tenere una sessione invisibile.
  for (const paneId of Object.keys(sessions)) {
    if (!allPanes(layout).includes(paneId)) delete sessions[paneId]
  }
  if (Object.keys(sessions).length === 0) return null

  return { layout, sessions }
}

function sanitizeLayout(raw: unknown, known: Set<string>): Layout | null {
  if (!raw || typeof raw !== 'object') return null
  const candidate = raw as Partial<Layout>

  const root = candidate.root ? sanitizeNode(candidate.root, known) : null

  const floating = Array.isArray(candidate.floating)
    ? candidate.floating.filter(
        (f) =>
          f &&
          typeof f.id === 'string' &&
          known.has(f.id) &&
          Number.isFinite(f.x) &&
          Number.isFinite(f.y) &&
          Number.isFinite(f.w) &&
          Number.isFinite(f.h)
      )
    : []

  if (!root && floating.length === 0) return null

  const ids = new Set([...collect(root), ...floating.map((f) => f.id)])
  const focused =
    typeof candidate.focused === 'string' && ids.has(candidate.focused)
      ? candidate.focused
      : ([...ids][0] ?? null)

  return {
    root,
    floating,
    focused,
    // Lo zoom non si ripristina: riaprire l'app con un riquadro che ne nasconde
    // altri due sembrerebbe che le sessioni siano andate perse.
    zoomed: null
  }
}

/** Pota i rami che puntano a riquadri non più esistenti, collassando gli split. */
function sanitizeNode(node: LayoutNode, known: Set<string>): LayoutNode | null {
  if (node?.kind === 'leaf') {
    return typeof node.id === 'string' && known.has(node.id) ? { kind: 'leaf', id: node.id } : null
  }
  if (node?.kind !== 'split') return null

  const a = node.a ? sanitizeNode(node.a, known) : null
  const b = node.b ? sanitizeNode(node.b, known) : null
  if (a && b) {
    const ratio = Number.isFinite(node.ratio) ? Math.min(0.9, Math.max(0.1, node.ratio)) : 0.5
    return { kind: 'split', dir: node.dir === 'v' ? 'v' : 'h', ratio, a, b }
  }
  return a ?? b
}

function collect(node: LayoutNode | null): string[] {
  if (!node) return []
  if (node.kind === 'leaf') return [node.id]
  return [...collect(node.a), ...collect(node.b)]
}
