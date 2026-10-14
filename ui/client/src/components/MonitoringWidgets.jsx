import React from 'react'
import { Link } from 'react-router'
import { TriangleAlert } from 'lucide-react'
import { Card, Icon } from './UI'
import { formatDateTime, operationLabel, timeAgo, timeUntil } from '../lib/format'

const HEALTH_STYLES = {
  ok: { dot: 'bg-emerald-400', text: 'text-emerald-400', label: 'Healthy' },
  degraded: { dot: 'bg-amber-400', text: 'text-amber-400', label: 'Degraded' },
  error: { dot: 'bg-red-400', text: 'text-red-400', label: 'Unhealthy' },
}

/** Compact health pill: status, Docker reachability and version. */
export function HealthIndicator({ health }) {
  if (!health) return null
  const s = HEALTH_STYLES[health.status] || HEALTH_STYLES.error
  const docker = health.checks?.docker?.reachable ? 'Docker reachable' : 'Docker unreachable'
  const db = health.checks?.database?.ok ? 'database ok' : 'database error'
  return (
    <div className="flex items-center gap-2 px-3 py-1.5 rounded-md border border-zinc-800 bg-zinc-900 text-xs"
      title={`${docker} · ${db} · up ${Math.round((health.uptimeSeconds || 0) / 60)} min`}>
      <span aria-hidden="true" className={`w-2 h-2 rounded-full ${s.dot} ${health.status === 'ok' ? '' : 'pulse-dot'}`} />
      <span className={`font-medium ${s.text}`}>{s.label}</span>
      <span className="text-zinc-400 font-mono">v{health.version}</span>
    </div>
  )
}

function Widget({ title, to, linkLabel, children }) {
  return (
    <Card className="flex flex-col">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 mb-3">
        <h2 className="font-semibold text-zinc-200 text-sm whitespace-nowrap">{title}</h2>
        {to && <Link to={to} className="text-xs text-zinc-400 hover:text-zinc-100 whitespace-nowrap">{linkLabel}</Link>}
      </div>
      <div className="flex-1">{children}</div>
    </Card>
  )
}

const STATUS_TEXT = { success: 'text-emerald-400', error: 'text-red-400', running: 'text-blue-400' }

const Empty = ({ children }) => <p className="text-xs text-zinc-400 py-4 text-center">{children}</p>

/**
 * Placeholder when loading failed, while loading (items undefined) or when
 * there is nothing to show; null otherwise.
 */
function placeholder(items, emptyText, error) {
  if (items === undefined && error) return <p className="text-xs text-red-400 py-4 text-center">Could not load: {error}</p>
  if (items === undefined) return <Empty>Loading…</Empty>
  return items.length ? null : <Empty>{emptyText}</Empty>
}

/** Failed jobs of the last 24 hours. */
export function RecentFailures({ failures, error }) {
  return (
    <Widget title="Failures (24 h)" to="/jobs?status=error" linkLabel="All failures">
      {placeholder(failures, 'No failed jobs in the last 24 hours', error) || (
        <ul className="space-y-2">
          {failures.map((j) => (
            <li key={j.id} className="text-xs">
              <Link to={`/jobs/${j.id}`} className="flex items-center justify-between gap-2 group">
                <span className="font-mono text-red-400 group-hover:underline">{operationLabel(j.type)}{j.database ? ` · ${j.database}` : ''}</span>
                <span className="text-zinc-400 shrink-0">{timeAgo(j.startedAt)}</span>
              </Link>
              {j.error && <p className="text-zinc-400 truncate" title={j.error}>{j.error}</p>}
            </li>
          ))}
        </ul>
      )}
    </Widget>
  )
}

/** Most recent successful backup per (server, database). */
export function LastBackups({ backups, error }) {
  return (
    <Widget title="Last successful backup" to="/backups" linkLabel="Backups">
      {placeholder(backups, 'No successful backups yet', error) || (
        <ul className="space-y-1.5">
          {backups.slice(0, 8).map((b) => (
            <li key={`${b.serverId}/${b.database}`} className="flex items-center justify-between gap-2 text-xs">
              <Link to={`/jobs/${b.jobId}`} className="font-mono text-zinc-300 hover:text-emerald-400 truncate">
                {b.database}<span className="text-zinc-400"> @ {b.serverName || b.serverId}</span>
              </Link>
              <span className="text-zinc-400 shrink-0" title={formatDateTime(b.finishedAt)}>{timeAgo(b.finishedAt)}</span>
            </li>
          ))}
        </ul>
      )}
    </Widget>
  )
}

/** Upcoming scheduled runs, flagging overdue schedules. */
export function NextRuns({ runs, error }) {
  return (
    <Widget title="Next scheduled runs" to="/schedules" linkLabel="Schedules">
      {placeholder(runs, 'No enabled schedules', error) || (
        <ul className="space-y-2.5">
          {runs.slice(0, 6).map((s) => (
            <li key={s.id} className="text-xs">
              <div className="flex items-center justify-between gap-2">
                <span className="text-zinc-300 truncate">{s.name}</span>
                <span className="text-zinc-400 shrink-0" title={formatDateTime(s.nextRunAt)}>{timeUntil(s.nextRunAt)}</span>
              </div>
              <p className="text-zinc-400 truncate">
                <span className="font-mono">{s.database}</span>
                {s.lastStatus && (
                  <>
                    {' · last '}
                    {s.lastJobId
                      ? <Link to={`/jobs/${s.lastJobId}`} className={`${STATUS_TEXT[s.lastStatus] || ''} hover:underline`}>{s.lastStatus}</Link>
                      : <span className={STATUS_TEXT[s.lastStatus] || ''}>{s.lastStatus}</span>}
                  </>
                )}
                {s.overdue && (
                  <span className="text-amber-400" title={s.overdueReason}>
                    {' · '}<Icon as={TriangleAlert} className="inline size-3.5 -mt-0.5" /> overdue
                  </span>
                )}
              </p>
            </li>
          ))}
        </ul>
      )}
    </Widget>
  )
}
