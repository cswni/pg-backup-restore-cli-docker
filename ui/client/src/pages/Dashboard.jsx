import React, { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../lib/api'
import { Card, Spinner, StatusBadge } from '../components/UI'

function StatCard({ icon, label, value, sub, to }) {
  const inner = (
    <Card className="hover:border-zinc-700 transition-colors cursor-default">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-xs text-zinc-500 uppercase tracking-wider font-medium">{label}</p>
          <div className="text-3xl font-bold text-zinc-100 mt-1">{value ?? '—'}</div>
          {sub && <p className="text-xs text-zinc-500 mt-1">{sub}</p>}
        </div>
        <span className="text-3xl opacity-70">{icon}</span>
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

export default function Dashboard() {
  const [containers, setContainers] = useState(null)
  const [backups, setBackups] = useState(null)
  const [jobs, setJobs] = useState(null)

  useEffect(() => {
    api.containers.list().then(setContainers).catch(() => setContainers([]))
    api.backups.list().then(setBackups).catch(() => setBackups([]))
    api.jobs.list().then(setJobs).catch(() => setJobs([]))
    const t = setInterval(() => {
      api.jobs.list().then(setJobs).catch(() => {})
    }, 3000)
    return () => clearInterval(t)
  }, [])

  const latestBackup = backups?.[0]
  const totalSize = backups?.reduce((a, b) => a + b.size, 0) ?? 0
  const runningJobs = jobs?.filter((j) => j.status === 'running') ?? []

  return (
    <div className="p-8">
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-zinc-100">Dashboard</h1>
        <p className="text-sm text-zinc-500 mt-1">PostgreSQL Backup & Restore — at a glance</p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4 mb-10">
        <StatCard
          icon="🐘"
          label="PostgreSQL Containers"
          value={containers ? containers.length : <Spinner size="sm" />}
          sub="running postgres instances"
          to="/containers"
        />
        <StatCard
          icon="🗄️"
          label="Backup Files"
          value={backups ? backups.length : <Spinner size="sm" />}
          sub={backups ? `${formatBytes(totalSize)} total` : ''}
          to="/backups"
        />
        <StatCard
          icon="🕐"
          label="Latest Backup"
          value={latestBackup ? timeAgo(latestBackup.mtime) : '—'}
          sub={latestBackup?.name ?? 'no backups yet'}
          to="/backups"
        />
        <StatCard
          icon="⚙️"
          label="Active Jobs"
          value={jobs ? runningJobs.length : <Spinner size="sm" />}
          sub={runningJobs.length ? 'in progress' : 'all idle'}
        />
      </div>

      {/* Recent Jobs */}
      <Card>
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-semibold text-zinc-200">Recent Jobs</h2>
          <Link to="/" onClick={() => api.jobs.list().then(setJobs)} className="text-xs text-zinc-500 hover:text-zinc-300">
            Refresh
          </Link>
        </div>
        {!jobs ? (
          <div className="flex justify-center py-8"><Spinner /></div>
        ) : jobs.length === 0 ? (
          <p className="text-zinc-500 text-sm text-center py-8">No jobs yet. Run an operation from the Containers page.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-zinc-500 uppercase tracking-wider border-b border-zinc-800">
                  <th className="pb-2 pr-4 font-medium">Operation</th>
                  <th className="pb-2 pr-4 font-medium">Container</th>
                  <th className="pb-2 pr-4 font-medium">Database</th>
                  <th className="pb-2 pr-4 font-medium">Status</th>
                  <th className="pb-2 font-medium">Started</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/60">
                {[...jobs].reverse().slice(0, 15).map((j) => (
                  <tr key={j.id} className="hover:bg-zinc-800/30 transition-colors">
                    <td className="py-2.5 pr-4">
                      <Link to={`/jobs/${j.id}`} className="font-mono text-emerald-400 hover:text-emerald-300 hover:underline">
                        {j.operation}
                      </Link>
                    </td>
                    <td className="py-2.5 pr-4 text-zinc-400 font-mono text-xs">{j.container}</td>
                    <td className="py-2.5 pr-4 text-zinc-400 font-mono text-xs">{j.database}</td>
                    <td className="py-2.5 pr-4"><StatusBadge status={j.status} /></td>
                    <td className="py-2.5 text-zinc-500 text-xs">{timeAgo(j.startedAt)}</td>
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

