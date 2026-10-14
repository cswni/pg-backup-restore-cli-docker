import React, { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router'
import { api } from '../lib/api'
import { Card, Spinner, StatusBadge, ErrorAlert } from '../components/UI'
import { HealthIndicator, RecentFailures, LastBackups, NextRuns } from '../components/MonitoringWidgets'

const JOBS_REFRESH_MS = 3000
const SUMMARY_REFRESH_MS = 30000

function StatCard({ icon, label, value, sub, to }) {
  const inner = (
    <Card className="hover:border-zinc-700 transition-colors cursor-default">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-xs text-zinc-400 uppercase tracking-wider font-medium">{label}</p>
          <div className="text-3xl font-bold text-zinc-100 mt-1">{value}</div>
          {sub && <p className="text-xs text-zinc-400 mt-1">{sub}</p>}
        </div>
        <span aria-hidden="true" className="text-3xl opacity-70">{icon}</span>
      </div>
    </Card>
  )
  return to ? <Link to={to}>{inner}</Link> : inner
}

function formatBytes(b) {
  if (b < 1024) return `${b} B`
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`
  return `${(b / 1024 / 1024).toFixed(2)} MB`
}

function timeAgo(ms) {
  const diff = Date.now() - ms
  if (diff < 60000) return 'just now'
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`
  return `${Math.floor(diff / 86400000)}d ago`
}

/**
 * Load `fetcher` now and every `intervalMs` (0 = once). A failed refresh keeps
 * the last good data and sets `error`, so failures are never shown as "0".
 */
function usePolled(fetcher, intervalMs = 0) {
  const [state, setState] = useState({ data: null, error: null })
  const load = useCallback(() => fetcher()
    .then((data) => setState({ data, error: null }))
    .catch((e) => setState((s) => ({ ...s, error: e.message }))), [fetcher])
  useEffect(() => {
    load()
    if (!intervalMs) return undefined
    const t = setInterval(load, intervalMs)
    return () => clearInterval(t)
  }, [load, intervalMs])
  return { ...state, reload: load }
}

const Unavailable = () => <span className="text-lg text-red-400">Unavailable</span>

/** Stat value: rendered data, "Unavailable" after a failed load, or a spinner while loading. */
function statValue(query, render) {
  if (query.data) return render(query.data)
  return query.error ? <Unavailable /> : <Spinner size="sm" />
}

const listContainers = () => api.containers.list()

export default function Dashboard() {
  const containers = usePolled(listContainers)
  const backups = usePolled(api.backups.list)
  const jobs = usePolled(api.jobs.list, JOBS_REFRESH_MS)
  const summary = usePolled(api.monitoring.summary, SUMMARY_REFRESH_MS)

  const latestBackup = backups.data?.[0]
  const totalSize = backups.data?.reduce((a, b) => a + b.size, 0) ?? 0
  const runningJobs = jobs.data?.filter((j) => j.status === 'running') ?? []
  const failed = [['Containers', containers], ['Backups', backups], ['Jobs', jobs], ['Monitoring', summary]]
    .filter(([, q]) => q.error)
  const summaryError = summary.data ? null : summary.error

  return (
    <div className="p-4 md:p-8">
      <div className="mb-8 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-zinc-100">Dashboard</h1>
          <p className="text-sm text-zinc-400 mt-1">Containers, backups, jobs and schedules on this server</p>
        </div>
        <HealthIndicator health={summary.data?.health} />
      </div>

      {failed.length > 0 && (
        <div className="mb-6">
          <ErrorAlert
            message={failed.map(([name, q]) => `${name}: ${q.error}`).join('. ')}
            onRetry={() => failed.forEach(([, q]) => q.reload())}
          />
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4 mb-10">
        <StatCard
          icon="🐘"
          label="Database Containers"
          value={statValue(containers, (list) => list.length)}
          sub="running database containers"
          to="/containers"
        />
        <StatCard
          icon="🗄️"
          label="Backup Files"
          value={statValue(backups, (list) => list.length)}
          sub={backups.data ? `${formatBytes(totalSize)} total` : ''}
          to="/backups"
        />
        <StatCard
          icon="🕐"
          label="Latest Backup"
          value={statValue(backups, () => (latestBackup ? timeAgo(latestBackup.mtime) : 'None'))}
          sub={backups.data ? latestBackup?.name ?? 'no backups yet' : ''}
          to="/backups"
        />
        <StatCard
          icon="⚙️"
          label="Active Jobs"
          value={statValue(jobs, () => runningJobs.length)}
          sub={jobs.data ? (runningJobs.length ? 'in progress' : 'all idle') : ''}
        />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4 mb-10">
        <RecentFailures failures={summary.data?.recentFailures} error={summaryError} />
        <LastBackups backups={summary.data?.lastBackups} error={summaryError} />
        <NextRuns runs={summary.data?.nextRuns} error={summaryError} />
      </div>

      {/* Recent Jobs */}
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
          <h2 className="font-semibold text-zinc-200">Recent Jobs</h2>
          <Link to="/jobs" className="text-xs text-zinc-400 hover:text-zinc-100">
            All jobs →
          </Link>
        </div>
        {!jobs.data ? (
          jobs.error
            ? <p className="text-red-400 text-sm text-center py-8">Jobs could not be loaded (see the error above).</p>
            : <div className="flex justify-center py-8"><Spinner /></div>
        ) : jobs.data.length === 0 ? (
          <p className="text-zinc-400 text-sm text-center py-8">No jobs yet. Run an operation from the Containers page.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-zinc-400 uppercase tracking-wider border-b border-zinc-800">
                  <th className="pb-2 pr-4 font-medium">Operation</th>
                  <th className="pb-2 pr-4 font-medium">Container</th>
                  <th className="pb-2 pr-4 font-medium">Database</th>
                  <th className="pb-2 pr-4 font-medium">Status</th>
                  <th className="pb-2 font-medium">Started</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/60">
                {jobs.data.slice(0, 15).map((j) => (
                  <tr key={j.id} className="hover:bg-zinc-800/30 transition-colors">
                    <td className="py-2.5 pr-4">
                      <Link to={`/jobs/${j.id}`} className="font-mono text-emerald-400 hover:text-emerald-300 hover:underline">
                        {j.operation}
                      </Link>
                    </td>
                    <td className="py-2.5 pr-4 text-zinc-400 font-mono text-xs">{j.container}</td>
                    <td className="py-2.5 pr-4 text-zinc-400 font-mono text-xs">{j.database}</td>
                    <td className="py-2.5 pr-4"><StatusBadge status={j.status} /></td>
                    <td className="py-2.5 text-zinc-400 text-xs">{timeAgo(j.startedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  )
}

