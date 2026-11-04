import { useEffect, useState } from 'react'
import type { UsageSummary } from '@shared/types'
import { shortenPath } from '../util/path'

export function formatTokens(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)} G`
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)} M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)} k`
  return String(n)
}

export function formatCost(n: number): string {
  if (n >= 100) return `$${n.toFixed(0)}`
  if (n >= 1) return `$${n.toFixed(2)}`
  return `$${n.toFixed(3)}`
}

interface UsagePanelProps {
  onClose: () => void
}

export function UsagePanel({ onClose }: UsagePanelProps): React.JSX.Element {
  const [summary, setSummary] = useState<UsageSummary | null>(null)

  useEffect(() => {
    void window.cm.usage.summary().then(setSummary)
  }, [])

  return (
    <div className="cm-overlay" onPointerDown={onClose}>
      <div className="cm-usage" onPointerDown={(e) => e.stopPropagation()}>
        <header className="cm-usage__head">
          <span className="cm-usage__title">Usage</span>
          <span className="cm-usage__spacer" />
          <button className="cm-iconbtn" onClick={onClose} title="Close (Esc)">
            ✕
          </button>
        </header>

        {!summary ? (
          <div className="cm-selector__empty">Reading transcripts…</div>
        ) : (
          <>
            <div className="cm-usage__stats">
              <Stat label="Today" cost={summary.todayCost} tokens={summary.todayTokens} />
              <Stat label="Last 7 days" cost={summary.weekCost} tokens={summary.weekTokens} />
              <Stat label="Total" cost={summary.totalCost} tokens={summary.totalTokens} />
              <Stat label="Transcripts" plain={String(summary.sessions)} />
            </div>

            <div className="cm-usage__cols">
              <section className="cm-usage__col">
                <div className="cm-field__label">By model</div>
                {summary.byModel.length === 0 ? (
                  <div className="cm-usage__none">no data</div>
                ) : (
                  summary.byModel.map((m) => (
                    <Bar
                      key={m.model}
                      label={m.model}
                      value={m.cost}
                      max={summary.byModel[0].cost}
                      detail={`${formatTokens(m.tokens)} tok · ${formatCost(m.cost)}`}
                    />
                  ))
                )}
              </section>

              <section className="cm-usage__col">
                <div className="cm-field__label">By directory</div>
                {summary.byProject.length === 0 ? (
                  <div className="cm-usage__none">no data</div>
                ) : (
                  summary.byProject.map((p) => (
                    <Bar
                      key={p.path}
                      label={shortenPath(p.path, 34)}
                      title={p.path}
                      value={p.cost}
                      max={summary.byProject[0].cost}
                      detail={`${formatTokens(p.tokens)} tok · ${formatCost(p.cost)}`}
                    />
                  ))
                )}
              </section>
            </div>

            <footer className="cm-usage__foot">
              Anthropic API list pricing. With a Max or Pro subscription, this reflects
              equivalent API consumption rather than direct billing.
            </footer>
          </>
        )}
      </div>
    </div>
  )
}

function Stat({
  label,
  cost,
  tokens,
  plain
}: {
  label: string
  cost?: number
  tokens?: number
  plain?: string
}): React.JSX.Element {
  return (
    <div className="cm-stat">
      <div className="cm-stat__label">{label}</div>
      <div className="cm-stat__value">{plain ?? (cost !== undefined ? formatCost(cost) : '—')}</div>
      {tokens !== undefined && (
        <div className="cm-stat__detail">{formatTokens(tokens)} tokens</div>
      )}
    </div>
  )
}

function Bar({
  label,
  value,
  max,
  detail,
  title
}: {
  label: string
  value: number
  max: number
  detail: string
  title?: string
}): React.JSX.Element {
  const percent = max > 0 ? Math.max(3, Math.round((value / max) * 100)) : 0
  return (
    <div className="cm-bar" title={title}>
      <div className="cm-bar__row">
        <span className="cm-bar__label">{label}</span>
        <span className="cm-bar__detail">{detail}</span>
      </div>
      <div className="cm-bar__track">
        <div className="cm-bar__fill" style={{ width: `${percent}%` }} />
      </div>
    </div>
  )
}
