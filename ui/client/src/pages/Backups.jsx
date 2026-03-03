import React, { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useFetch } from '../hooks/useFetch'
import { api } from '../lib/api'
import {
  PageHeader, Card, Spinner, ErrorAlert, EmptyState, Button
} from '../components/UI'

function formatBytes(b) {
  if (b < 1024) return `${b} B`
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`
  return `${(b / 1024 / 1024).toFixed(2)} MB`
}

function formatDate(ms) {
  return new Date(ms).toLocaleString()
}

function parseDbName(filename) {
  // e.g. mydb_12-03-2025_14_30_00.sql → mydb
  const m = filename.match(/^(.+?)_\d{2}-\d{2}-\d{4}/)
  return m ? m[1] : filename.replace(/\.sql$/, '')
}

function RestoreModal({ backup, onClose, onRestore }) {
  const { data: containers, loading } = useFetch(api.containers.list)
  const [container, setContainer] = useState('')
  const [db, setDb] = useState(parseDbName(backup.name))
  const [running, setRunning] = useState(false)

  async function submit() {
    if (!container || !db) return
    setRunning(true)
    try {
      await onRestore({ container, database: db, file: backup.name })
    } finally {
      setRunning(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
      <div className="bg-zinc-900 border border-zinc-700 rounded-2xl w-full max-w-md shadow-2xl">
        <div className="flex items-center gap-3 px-6 py-5 border-b border-zinc-800">
          <span className="text-2xl">♻️</span>
          <div>
            <p className="font-semibold text-zinc-100">Restore</p>
            <p className="text-xs text-zinc-500 font-mono mt-0.5 truncate max-w-[280px]">{backup.name}</p>
          </div>
          <button onClick={onClose} className="ml-auto text-zinc-600 hover:text-zinc-300 text-xl leading-none">✕</button>
        </div>

        <div className="px-6 py-5 space-y-4">
          <div>
            <label className="block text-xs text-zinc-500 mb-1 font-medium uppercase tracking-wider">Target Container</label>
            {loading ? <Spinner size="sm" /> : (
              <select
                value={container}
                onChange={(e) => setContainer(e.target.value)}
                className="w-full bg-zinc-800 border border-zinc-700 focus:border-emerald-500 rounded-lg px-3 py-2 text-sm font-mono text-zinc-100 outline-none transition-colors"
              >
                <option value="">— select container —</option>
                {(containers || []).map((c) => (
                  <option key={c.idFull} value={c.name}>{c.name}</option>
                ))}
              </select>
            )}
          </div>
          <div>
            <label className="block text-xs text-zinc-500 mb-1 font-medium uppercase tracking-wider">Database Name</label>
            <input
              type="text"
              value={db}
              onChange={(e) => setDb(e.target.value)}
              className="w-full bg-zinc-800 border border-zinc-700 focus:border-emerald-500 rounded-lg px-3 py-2 text-sm font-mono text-zinc-100 placeholder-zinc-600 outline-none transition-colors"
            />
          </div>
        </div>

        <div className="flex justify-end gap-2 px-6 py-4 border-t border-zinc-800">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!container || !db || running} onClick={submit}>
            {running ? <><span className="animate-spin">⟳</span> Running…</> : 'Restore'}
          </Button>
        </div>
      </div>
    </div>
  )
}

export default function Backups() {
  const { data: backups, loading, error, reload } = useFetch(api.backups.list)
  const [restoreTarget, setRestoreTarget] = useState(null)
  const [deleting, setDeleting] = useState(null)
  const [toast, setToast] = useState(null)
  const navigate = useNavigate()

  const showToast = (type, msg) => {
    setToast({ type, msg })
    setTimeout(() => setToast(null), 4000)
  }

  async function handleDelete(filename) {
    setDeleting(filename)
    try {
      await api.backups.delete(filename)
      showToast('success', `Deleted ${filename}`)
      reload()
    } catch (e) {
      showToast('error', e.message)
    } finally {
      setDeleting(null)
    }
  }

  async function handleRestore(params) {
    try {
      const { jobId } = await api.ops.run('restore', params)
      setRestoreTarget(null)
      navigate(`/jobs/${jobId}`)
    } catch (e) {
      showToast('error', e.message)
    }
  }

  const totalSize = (backups || []).reduce((a, b) => a + b.size, 0)

  return (
    <div className="p-8">
      <PageHeader
        title="Backups"
        subtitle={backups ? `${backups.length} files · ${formatBytes(totalSize)} total` : 'Dump files in /backups'}
        action={<Button variant="secondary" size="sm" onClick={reload}>↻ Refresh</Button>}
      />

      {toast && (
        <div className={`mb-6 flex items-center gap-2 px-4 py-3 rounded-xl text-sm border ${
          toast.type === 'error'
            ? 'bg-red-500/10 border-red-500/20 text-red-400'
            : 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400'
        }`}>
          <span>{toast.type === 'error' ? '⚠️' : '✅'}</span>
          {toast.msg}
        </div>
      )}

      {loading && <div className="flex justify-center py-20"><Spinner /></div>}
      {error && <ErrorAlert message={error} onRetry={reload} />}

      {!loading && !error && (!backups || backups.length === 0) && (
        <EmptyState
          icon="🗄️"
          title="No backup files"
          description="Run an Export operation on a container to create your first .sql dump."
        />
      )}

      {!loading && !error && backups && backups.length > 0 && (
        <Card className="overflow-hidden p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-zinc-500 uppercase tracking-wider border-b border-zinc-800 bg-zinc-950/50">
                  <th className="px-5 py-3 font-medium">Filename</th>
                  <th className="px-5 py-3 font-medium">Size</th>
                  <th className="px-5 py-3 font-medium">Date</th>
                  <th className="px-5 py-3 font-medium text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/60">
                {backups.map((b) => (
                  <tr key={b.name} className="hover:bg-zinc-800/30 transition-colors group">
                    <td className="px-5 py-3.5">
                      <div className="flex items-center gap-2">
                        <span className="text-base">📄</span>
                        <span className="font-mono text-xs text-zinc-300">{b.name}</span>
                      </div>
                    </td>
                    <td className="px-5 py-3.5 text-zinc-500 text-xs font-mono">{formatBytes(b.size)}</td>
                    <td className="px-5 py-3.5 text-zinc-500 text-xs">{formatDate(b.mtime)}</td>
                    <td className="px-5 py-3.5">
                      <div className="flex justify-end gap-1.5">
                        <a
                          href={api.backups.downloadUrl(b.name)}
                          download
                          className="px-3 py-1.5 rounded-md text-xs font-medium text-zinc-400 hover:bg-zinc-700 hover:text-zinc-100 transition-colors"
                        >
                          ⬇ Download
                        </a>
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => setRestoreTarget(b)}
                        >
                          ♻️ Restore
                        </Button>
                        <Button
                          size="sm"
                          variant="danger"
                          disabled={deleting === b.name}
                          onClick={() => handleDelete(b.name)}
                        >
                          {deleting === b.name ? '…' : '🗑️'}
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {restoreTarget && (
        <RestoreModal
          backup={restoreTarget}
          onClose={() => setRestoreTarget(null)}
          onRestore={handleRestore}
        />
      )}
    </div>
  )
}
