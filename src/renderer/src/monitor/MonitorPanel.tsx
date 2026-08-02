import type { MonitorPane, MonitorState } from '@shared/types'
import { formatCost, formatTokens } from '../usage/UsagePanel'

/**
 * Contenuto del pannello di monitoraggio.
 *
 * Lo stesso componente disegna il cassetto agganciato e la finestra staccata:
 * cambia solo la cornice attorno. Non conosce nessuna delle due — riceve lo
 * stato e basta, così non può divergere fra i due contenitori.
 */

interface MonitorPanelProps {
  state: MonitorState | null
  /** Assente nella finestra staccata, che non può dare il fuoco a un riquadro. */
  onFocusPane?: (paneId: string) => void
}

export function MonitorPanel({ state, onFocusPane }: MonitorPanelProps): React.JSX.Element {
  if (!state) return <div className="cm-monitor__empty">Lettura…</div>

  return (
    <div className="cm-monitor__body">
      <div className="cm-monitor__totals">
        <div className="cm-monitor__total">
          <span className="cm-monitor__total-value">{formatCost(state.todayCost)}</span>
          <span className="cm-monitor__total-label">oggi</span>
        </div>
        <div className="cm-monitor__total">
          <span className="cm-monitor__total-value">{formatTokens(state.todayTokens)}</span>
          <span className="cm-monitor__total-label">token</span>
        </div>
        <div className="cm-monitor__total">
          <span className="cm-monitor__total-value">{state.panes.length}</span>
          <span className="cm-monitor__total-label">
            {state.panes.length === 1 ? 'sessione' : 'sessioni'}
          </span>
        </div>
      </div>

      {state.panes.length === 0 ? (
        <div className="cm-monitor__empty">Nessuna sessione aperta.</div>
      ) : (
        <div className="cm-monitor__list">
          {state.panes.map((pane) => (
            <Row key={pane.paneId} pane={pane} onFocus={onFocusPane} />
          ))}
        </div>
      )}

      <div className="cm-monitor__foot">
        Costi a tariffe di listino. Il riempimento del contesto è stimato dai token in
        ingresso dell&apos;ultimo turno.
      </div>
    </div>
  )
}

function Row({
  pane,
  onFocus
}: {
  pane: MonitorPane
  onFocus?: (paneId: string) => void
}): React.JSX.Element {
  const usage = pane.usage
  // Senza finestra nota non si mostra una percentuale: un numero inventato
  // sarebbe peggio di nessun numero.
  const fill =
    usage && usage.contextWindow > 0
      ? Math.min(100, Math.round((usage.contextTokens / usage.contextWindow) * 100))
      : null

  return (
    <div
      className={`cm-monitor__row ${onFocus ? 'cm-monitor__row--clickable' : ''}`}
      onClick={() => onFocus?.(pane.paneId)}
      title={pane.where}
    >
      <div className="cm-monitor__head">
        <span className="cm-monitor__index">{pane.index}</span>
        <span className={`cm-pane__dot cm-pane__dot--${pane.status}`} />
        {pane.remote && <span className="cm-monitor__remote">☁</span>}
        <span className="cm-monitor__label">{pane.label}</span>
        {usage && <span className="cm-monitor__cost">{formatCost(usage.cost)}</span>}
      </div>

      {fill !== null && usage ? (
        <>
          <div className="cm-monitor__bar" aria-hidden>
            <div
              className={`cm-monitor__fill ${fill >= 80 ? 'cm-monitor__fill--high' : ''}`}
              style={{ width: `${fill}%` }}
            />
          </div>
          <div className="cm-monitor__detail">
            contesto {fill}%
            {usage.contextApproximate ? ' circa' : ''} · {formatTokens(usage.contextTokens)} di{' '}
            {formatTokens(usage.contextWindow)} · {usage.turns} turni
          </div>
        </>
      ) : (
        <div className="cm-monitor__detail">
          {pane.waitingFor
            ? pane.waitingFor
            : usage
              ? `${usage.turns} turni · ${formatTokens(usage.tokens)} token`
              : 'nessun dato ancora'}
        </div>
      )}
    </div>
  )
}
