import React, { useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { useFetch } from '../hooks/useFetch'
import { api } from '../lib/api'
import { useAuth } from '../lib/auth'
import { describeCron } from '../lib/cron'
import { formatDateTime, timeAgo, timeUntil } from '../lib/format'
import { CalendarClock, Play, Plus, TriangleAlert } from 'lucide-react'
import { PageHeader, Card, Spinner, ErrorAlert, EmptyState, Button, StatusBadge, Toggle, Icon } from '../components/UI'
import ScheduleForm from '../components/ScheduleForm'

function Target({ s }) {
  return (
    <div className="font-mono text-xs leading-relaxed">
      <p className="text-zinc-200">{s.database}{s.outputName && <span className="text-zinc-400"> as {s.outputName}</span>}</p>
      <p className="text-zinc-400">{s.serverId}{s.container && ` / ${s.container}`} · {s.engine}</p>
    </div>
  )
}

function LastRun({ s }) {
  if (!s.lastRunAt) return <span className="text-xs text-zinc-400">never run</span>
  return (
    <div className="flex flex-col items-start gap-1">
      {s.lastJobId ? (
        <Link to={`/jobs/${s.lastJobId}`} className="hover:opacity-80" title="Open job log"><StatusBadge status={s.lastStatus} /></Link>
      ) : <StatusBadge status={s.lastStatus} />}
      <span className="text-xs text-zinc-400" title={formatDateTime(s.lastRunAt)}>{timeAgo(s.lastRunAt)}</span>
    </div>
  )
}

function RowActions({ s, isAdmin, busy, onRun, onEdit, onDelete }) {
  const [confirming, setConfirming] = useState(false)
  if (confirming) {
    return (
      <div className="flex items-center justify-end gap-2">
        <span className="text-xs text-red-400">Delete “{s.name}”?</span>
        <Button size="sm" variant="danger" onClick={() => { setConfirming(false); onDelete(s) }}>Delete</Button>
        <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>Cancel</Button>
      </div>
    )
  }
  return (
    <div className="flex items-center justify-end gap-1.5 whitespace-nowrap">
      <Button size="sm" variant="secondary" disabled={busy || s.lastStatus === 'running'} onClick={() => onRun(s)}><Icon as={Play} /> Run now</Button>
      {isAdmin && <Button size="sm" variant="ghost" onClick={() => onEdit(s)}>Edit</Button>}
      {isAdmin && <Button size="sm" variant="ghost" className="hover:text-red-400!" onClick={() => setConfirming(true)}>Delete</Button>}
    </div>
  )
}

function ScheduleRow({ s, isAdmin, busy, onToggle, ...actions }) {
  return (
    <tr className="align-top hover:bg-zinc-800/30 transition-colors">
      <td className="py-3 pr-4">
        <p className="text-zinc-100 font-medium">{s.name}</p>
        {s.overdue && (
          <p className="flex items-start gap-1 text-xs text-amber-400 mt-0.5">
            <Icon as={TriangleAlert} className="size-3.5 mt-px" /> Overdue: {s.overdueReason}
          </p>
        )}
      </td>
      <td className="py-3 pr-4"><Target s={s} /></td>
      <td className="py-3 pr-4">
        <p className="text-zinc-300 text-xs">{describeCron(s.cron)}</p>
        <p className="text-zinc-400 text-[11px] font-mono">{s.cron} · {s.timezone}</p>
      </td>
      <td className="py-3 pr-4 text-xs">
        {s.enabled && s.nextRunAt
          ? <span className="text-zinc-300" title={formatDateTime(s.nextRunAt)}>{timeUntil(s.nextRunAt)}</span>
          : <span className="text-zinc-400">{s.enabled ? 'none' : 'paused'}</span>}
      </td>
      <td className="py-3 pr-4"><LastRun s={s} /></td>
      <td className="py-3 pr-4">
        {isAdmin
          ? <Toggle checked={s.enabled} onChange={(v) => onToggle(s, v)} label={s.enabled ? 'On' : 'Off'} />
          : <span className="text-xs text-zinc-400">{s.enabled ? 'on' : 'off'}</span>}
      </td>
      <td className="py-3"><RowActions s={s} isAdmin={isAdmin} busy={busy} {...actions} /></td>
    </tr>
  )
}

/**
 * Backup schedules: list, create/edit, enable/disable, run now, delete.
 * Write actions are hidden for non-admins (the API enforces it too).
 */
export default function Schedules() {
  const { isAdmin } = useAuth()
  const navigate = useNavigate()
  const { data, loading, error, reload } = useFetch(() => api.schedules.list())
  const [editing, setEditing] = useState(null) // null | 'new' | schedule
  const [busyId, setBusyId] = useState(null)
  const [actionError, setActionError] = useState(null)

  const act = async (id, fn) => {
    setBusyId(id)
    setActionError(null)
    try {
      await fn()
      await reload()
    } catch (err) {
      setActionError(err.message)
    } finally {
      setBusyId(null)
    }
  }

  const handlers = {
    onRun: (s) => act(s.id, async () => navigate(`/jobs/${(await api.schedules.run(s.id)).jobId}`)),
    onToggle: (s, enabled) => act(s.id, () => api.schedules.update(s.id, { enabled })),
    onDelete: (s) => act(s.id, () => api.schedules.remove(s.id)),
    onEdit: (s) => setEditing(s),
  }

  const action = isAdmin && !editing && <Button onClick={() => setEditing('new')}><Icon as={Plus} /> New schedule</Button>

  return (
    <div className="p-4 md:p-8">
      <PageHeader title="Schedules" subtitle="Automatic backups on a cron schedule" action={action} />
      {editing && (
        <ScheduleForm
          key={editing === 'new' ? 'new' : editing.id}
          schedule={editing === 'new' ? null : editing}
          onCancel={() => setEditing(null)}
          onSaved={() => { setEditing(null); reload() }}
        />
      )}
      {actionError && <div className="mb-4"><ErrorAlert message={actionError} /></div>}
      {loading && !data ? (
        <div className="flex justify-center py-16"><Spinner /></div>
      ) : error ? (
        <ErrorAlert message={error} onRetry={reload} />
      ) : data.length === 0 ? (
        <EmptyState icon={CalendarClock} title="No schedules yet" description="Create a schedule to back up a database automatically." />
      ) : (
        <Card className="overflow-x-auto p-0!">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-zinc-400 uppercase tracking-wider border-b border-zinc-800">
                {['Name', 'Target', 'Schedule', 'Next run', 'Last run', 'Enabled', ''].map((h) => (
                  <th key={h} className="py-3 pr-4 first:pl-5 font-medium whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800/60 [&_td:first-child]:pl-5 [&_td:last-child]:pr-5">
              {data.map((s) => (
                <ScheduleRow key={s.id} s={s} isAdmin={isAdmin} busy={busyId === s.id} {...handlers} />
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  )
}
