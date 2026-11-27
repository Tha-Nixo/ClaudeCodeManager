import type { MonitorPane, MonitorState } from '@shared/types'
import { costOrigin, formatCost, formatTokens } from '../usage/UsagePanel'

/**
 * Contents of the monitor panel.
 *
 * The same component draws the docked drawer and the detached window: only
 * the frame around it changes. It knows neither of them; it just receives the
 * state, so it cannot diverge between the two containers.
 */
interface MonitorPanelProps {
  state: MonitorState | null
  /** Absent in the detached window, which cannot give focus to a pane. */
  onFocusPane?: (paneId: string) => void
}

export function MonitorPanel({ state, onFocusPane }: MonitorPanelProps): React.JSX.Element {
  if (!state) return <div className="cm-monitor__empty">Loading…</div>

  return (
    <div className="cm-monitor__body">
      <div className="cm-monitor__totals">
        <div className="cm-monitor__total">
          <span className="cm-monitor__total-value">{formatCost(state.todayCost)}</span>
          <span className="cm-monitor__total-label">today</span>
        </div>
        <div className="cm-monitor__total">
          <span className="cm-monitor__total-value">{formatTokens(state.todayTokens)}</span>
          <span className="cm-monitor__total-label">tokens</span>
        </div>
        <div className="cm-monitor__total">
          <span className="cm-monitor__total-value">{state.panes.length}</span>
          <span className="cm-monitor__total-label">
            {state.panes.length === 1 ? 'session' : 'sessions'}
          </span>
        </div>
      </div>

      {state.panes.length === 0 ? (
        <div className="cm-monitor__empty">No active sessions.</div>
      ) : (
        <div className="cm-monitor__list">
          {state.panes.map((pane) => (
            <Row key={pane.paneId} pane={pane} onFocus={onFocusPane} />
          ))}
        </div>
      )}

      <div className="cm-monitor__foot">
        List pricing. Context saturation estimated from last turn input tokens.
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
  // Without a known window no percentage is shown: an invented number would be
  // worse than no number.
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
        {usage && <SessionCost cost={usage.cost} reportedCost={usage.reportedCost} />}
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
            context {fill}%
            {usage.contextApproximate ? ' approx' : ''} · {formatTokens(usage.contextTokens)} of{' '}
            {formatTokens(usage.contextWindow)} · {usage.turns} turns
          </div>
        </>
      ) : (
        <div className="cm-monitor__detail">
          {pane.waitingFor
            ? pane.waitingFor
            : usage
              ? `${usage.turns} turns · ${formatTokens(usage.tokens)} tokens`
              : 'no data yet'}
        </div>
      )}
    </div>
  )
}

/** A session's cost, marked with ~ when part of it is estimated (#25). */
function SessionCost({ cost, reportedCost }: { cost: number; reportedCost: number }): React.JSX.Element {
  const { estimated, title } = costOrigin(cost, reportedCost)
  return (
    <span className="cm-monitor__cost" title={title}>
      {estimated ? '~' : ''}
      {formatCost(cost)}
    </span>
  )
}
