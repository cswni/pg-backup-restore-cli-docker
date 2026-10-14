import React, { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { api } from '../lib/api'
import { CalendarClock, ListChecks, RefreshCw } from 'lucide-react'
import { formatDateTime, formatDuration, operationLabel, timeAgo } from '../lib/format'
import { PageHeader, Card, Spinner, ErrorAlert, EmptyState, Button, StatusBadge, Icon, CHIP_CLASS } from '../components/UI'

const PAGE_SIZE = 25
const REFRESH_MS = 5000
const TYPES = ['', 'export', 'restore', 'create', 'delete', 'unblock']
const STATUSES = ['', 'running', 'success', 'error']
const selectCls = 'bg-zinc-800 border border-zinc-500 rounded-lg px-3 py-1.5 text-sm text-zinc-200 outline-hidden focus:border-emerald-500'

/** One page of job history; fetches PAGE_SIZE + 1 rows to know whether a next page exists. */
function useJobsPage({ type, status, page }) {
  const [state, setState] = useState({ jobs: null, hasMore: false, error: null })
  const [tick, setTick] = useState(0)

  useEffect(() => {
    let cancelled = false
    api.jobs.list({ type, status, limit: PAGE_SIZE + 1, offset: page * PAGE_SIZE })
      .then((rows) => { if (!cancelled) setState({ jobs: rows.slice(0, PAGE_SIZE), hasMore: rows.length > PAGE_SIZE, error: null }) })
      .catch((err) => { if (!cancelled) setState((s) => ({ ...s, error: err.message })) })
    return () => { cancelled = true }
  }, [type, status, page, tick])

  const hasRunning = !!state.jobs?.some((j) => j.status === 'running')
  useEffect(() => {
    if (!hasRunning) return undefined
    const t = setInterval(() => setTick((n) => n + 1), REFRESH_MS)
    return () => clearInterval(t)
  }, [hasRunning])

  return { ...state, reload: () => setTick((n) => n + 1) }
}

function Filter({ label, value, options, format = (o) => o, onChange }) {
  return (
    <label className="flex items-center gap-2 text-xs text-zinc-400">
      {label}
      <select value={value} onChange={(e) => onChange(e.target.value)} className={selectCls}>
        {options.map((o) => <option key={o} value={o}>{o ? format(o) : 'all'}</option>)}
      </select>
    </label>
  )
}

function JobRow({ j }) {
  const m = j.meta || {}
  return (
    <tr className="hover:bg-zinc-800/30 transition-colors">
      <td className="py-2.5 pr-4">
        <Link to={`/jobs/${j.id}`} className="font-mono text-emerald-400 hover:text-emerald-300 hover:underline">{operationLabel(j.type)}</Link>
        {m.scheduleId && (
          <span className={`ml-2 ${CHIP_CLASS}`}>
            <Icon as={CalendarClock} className="size-3" /> {m.scheduleName || 'schedule'}
          </span>
        )}
      </td>
      <td className="py-2.5 pr-4 font-mono text-xs text-zinc-400">
        {[m.serverName || m.serverId, m.container, m.database].filter(Boolean).join(' / ') || 'n/a'}
        {m.file && <p className="text-zinc-400 truncate max-w-xs">{m.file}</p>}
      </td>
      <td className="py-2.5 pr-4 text-xs text-zinc-400">{j.username || 'n/a'}</td>
      <td className="py-2.5 pr-4"><StatusBadge status={j.status} /></td>
      <td className="py-2.5 pr-4 text-xs text-zinc-400" title={formatDateTime(j.startedAt)}>{timeAgo(j.startedAt)}</td>
      <td className="py-2.5 pr-4 text-xs font-mono text-zinc-400">{j.status === 'running' ? '…' : formatDuration(j.startedAt, j.finishedAt)}</td>
      <td className="py-2.5 text-right">
        <Link to={`/jobs/${j.id}`} className="text-xs text-zinc-400 hover:text-zinc-200">Log</Link>
      </td>
    </tr>
  )
}

/** Job history with type/status filters and pagination (filters live in the URL). */
export default function Jobs() {
  const [params, setParams] = useSearchParams()
  const type = params.get('type') || ''
  const status = params.get('status') || ''
  const page = Math.max(0, Number(params.get('page')) || 0)
  const { jobs, hasMore, error, reload } = useJobsPage({ type, status, page })

  const update = (patch) => {
    const next = Object.fromEntries(Object.entries({ type, status, page: page || '', ...patch }).filter(([, v]) => v !== '' && v !== 0))
    setParams(next)
  }

  return (
    <div className="p-4 md:p-8">
      <PageHeader title="Jobs" subtitle="History of every backup, restore and maintenance operation"
        action={<Button variant="secondary" size="sm" onClick={reload}><Icon as={RefreshCw} /> Refresh</Button>} />
      <div className="flex flex-wrap items-center gap-4 mb-4">
        <Filter label="Type" value={type} options={TYPES} format={operationLabel} onChange={(v) => update({ type: v, page: 0 })} />
        <Filter label="Status" value={status} options={STATUSES} onChange={(v) => update({ status: v, page: 0 })} />
      </div>
      {error && <div className="mb-4"><ErrorAlert message={error} onRetry={reload} /></div>}
      {!jobs ? (
        !error && <div className="flex justify-center py-16"><Spinner /></div>
      ) : jobs.length === 0 ? (
        <EmptyState icon={ListChecks} title="No jobs" description={type || status ? 'No jobs match these filters.' : 'Jobs appear here once you run an operation.'} />
      ) : (
        <Card className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-zinc-400 uppercase tracking-wider border-b border-zinc-800">
                {['Operation', 'Target', 'User', 'Status', 'Started', 'Duration', ''].map((h) => <th key={h} className="pb-2 pr-4 font-medium">{h}</th>)}
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800/60">
              {jobs.map((j) => <JobRow key={j.id} j={j} />)}
            </tbody>
          </table>
        </Card>
      )}
      <div className="flex flex-wrap items-center justify-between gap-3 mt-4 text-xs text-zinc-400">
        <span>Page {page + 1}</span>
        <div className="flex gap-2">
          <Button size="sm" variant="secondary" disabled={page === 0} onClick={() => update({ page: page - 1 })}>Newer</Button>
          <Button size="sm" variant="secondary" disabled={!hasMore} onClick={() => update({ page: page + 1 })}>Older</Button>
        </div>
      </div>
    </div>
  )
}
