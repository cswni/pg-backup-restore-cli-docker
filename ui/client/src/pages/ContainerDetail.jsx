import React, { useState } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { useFetch } from '../hooks/useFetch'
import { api } from '../lib/api'
import {
  PageHeader, Card, Spinner, ErrorAlert, EmptyState, Button
} from '../components/UI'

const OPERATIONS = [
  { id: 'export',  label: 'Export',   icon: '📤', variant: 'primary',   desc: 'Dump database to /backups' },
  { id: 'create',  label: 'Create',   icon: '➕', variant: 'primary',   desc: 'Create a new database' },
  { id: 'unblock', label: 'Unblock',  icon: '🔓', variant: 'secondary', desc: 'Terminate active connections' },
  { id: 'restore', label: 'Restore',  icon: '♻️', variant: 'secondary', desc: 'Restore from latest dump' },
  { id: 'delete',  label: 'Delete',   icon: '🗑️', variant: 'danger',    desc: 'Drop database (irreversible!)' },
]

function OperationModal({ op, container, databases, backups, onClose, onRun }) {
  const [db, setDb] = useState('')
  const [customDb, setCustomDb] = useState('')
  const [file, setFile] = useState('')
  const [confirm, setConfirm] = useState('')
  const [running, setRunning] = useState(false)

  const needsFile = op.id === 'restore'
  const isCreate = op.id === 'create'
  const isDanger = op.id === 'delete'
  const finalDb = isCreate ? customDb : db

  const valid =
    finalDb &&
    (!needsFile || true) && // file is optional for restore
    (!isDanger || confirm === finalDb)

  async function submit() {
    if (!valid) return
    setRunning(true)
    try {
      await onRun(op.id, { container, database: finalDb, file: file || undefined })
    } finally {
      setRunning(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
      <div className="bg-zinc-900 border border-zinc-700 rounded-2xl w-full max-w-md shadow-2xl">
        {/* Header */}
        <div className="flex items-center gap-3 px-6 py-5 border-b border-zinc-800">
          <span className="text-2xl">{op.icon}</span>
          <div>
            <p className="font-semibold text-zinc-100">{op.label}</p>
            <p className="text-xs text-zinc-500 mt-0.5">{op.desc}</p>
          </div>
          <button onClick={onClose} className="ml-auto text-zinc-600 hover:text-zinc-300 text-xl leading-none">✕</button>
        </div>

        <div className="px-6 py-5 space-y-4">
          {/* Container info */}
          <div>
            <label className="block text-xs text-zinc-500 mb-1 font-medium uppercase tracking-wider">Container</label>
            <p className="font-mono text-sm text-emerald-400 bg-zinc-800 rounded-lg px-3 py-2">{container}</p>
          </div>

          {/* Database selector or input */}
          <div>
            <label className="block text-xs text-zinc-500 mb-1 font-medium uppercase tracking-wider">Database</label>
            {isCreate ? (
              <input
                type="text"
                placeholder="new_database_name"
                value={customDb}
                onChange={(e) => setCustomDb(e.target.value)}
                className="w-full bg-zinc-800 border border-zinc-700 focus:border-emerald-500 rounded-lg px-3 py-2 text-sm font-mono text-zinc-100 placeholder-zinc-600 outline-none transition-colors"
              />
            ) : (
              <select
                value={db}
                onChange={(e) => setDb(e.target.value)}
                className="w-full bg-zinc-800 border border-zinc-700 focus:border-emerald-500 rounded-lg px-3 py-2 text-sm font-mono text-zinc-100 outline-none transition-colors"
              >
                <option value="">— select database —</option>
                {(databases || []).map((d) => (
                  <option key={d} value={d}>{d}</option>
                ))}
              </select>
            )}
          </div>

          {/* Restore file picker */}
          {needsFile && (
            <div>
              <label className="block text-xs text-zinc-500 mb-1 font-medium uppercase tracking-wider">
                Dump File <span className="text-zinc-600 normal-case">(optional — uses latest if empty)</span>
              </label>
              <select
                value={file}
                onChange={(e) => setFile(e.target.value)}
                className="w-full bg-zinc-800 border border-zinc-700 focus:border-emerald-500 rounded-lg px-3 py-2 text-sm font-mono text-zinc-100 outline-none transition-colors"
              >
                <option value="">— auto (latest) —</option>
                {(backups || []).map((b) => (
                  <option key={b.name} value={b.name}>{b.name}</option>
                ))}
              </select>
            </div>
          )}

          {/* Danger confirmation */}
          {isDanger && finalDb && (
            <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-4">
              <p className="text-xs text-red-400 mb-2 font-medium">
                ⚠️ This will permanently drop <strong>{finalDb}</strong>. Type the database name to confirm:
              </p>
              <input
                type="text"
                placeholder={finalDb}
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                className="w-full bg-zinc-900 border border-red-500/30 focus:border-red-500 rounded-lg px-3 py-2 text-sm font-mono text-red-300 placeholder-red-900 outline-none transition-colors"
              />
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 px-6 py-4 border-t border-zinc-800">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            variant={op.variant}
            disabled={!valid || running}
            onClick={submit}
          >
            {running ? <><span className="animate-spin">⟳</span> Running…</> : `Run ${op.label}`}
          </Button>
        </div>
      </div>
    </div>
  )
}

export default function ContainerDetail() {
  const { name } = useParams()
  const navigate = useNavigate()
  const containerName = decodeURIComponent(name)

  const { data: databases, loading: dbLoading, error: dbError, reload: reloadDbs } =
    useFetch(() => api.containers.databases(containerName), [containerName])

  const { data: backups } = useFetch(api.backups.list)

  const [activeOp, setActiveOp] = useState(null)
  const [toast, setToast] = useState(null)

  async function handleRun(operation, params) {
    try {
      const { jobId } = await api.ops.run(operation, params)
      setActiveOp(null)
      navigate(`/jobs/${jobId}`)
    } catch (e) {
      setToast({ type: 'error', msg: e.message })
      setTimeout(() => setToast(null), 5000)
    }
  }

  return (
    <div className="p-8">
      <div className="mb-2">
        <Link to="/containers" className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors">← Containers</Link>
      </div>
      <PageHeader
        title={containerName}
        subtitle="Select a database and run an operation"
        action={<Button variant="secondary" size="sm" onClick={reloadDbs}>↻ Refresh</Button>}
      />

      {/* Toast */}
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

      {/* Operations grid */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 mb-8">
        {OPERATIONS.map((op) => (
          <button
            key={op.id}
            onClick={() => setActiveOp(op)}
            className={`flex flex-col items-center gap-2 p-4 rounded-xl border transition-all duration-150 text-sm font-medium
              ${op.variant === 'danger'
                ? 'border-red-500/20 bg-red-500/5 text-red-400 hover:bg-red-500/15 hover:border-red-500/40'
                : 'border-zinc-800 bg-zinc-900 text-zinc-300 hover:border-emerald-500/30 hover:bg-zinc-800 hover:text-zinc-100'
              }`}
          >
            <span className="text-2xl">{op.icon}</span>
            {op.label}
          </button>
        ))}
      </div>

      {/* Databases */}
      <Card>
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-semibold text-zinc-200">Databases</h2>
          <span className="text-xs text-zinc-600">Click an operation above to act on a database</span>
        </div>

        {dbLoading && <div className="flex justify-center py-10"><Spinner /></div>}
        {dbError && <ErrorAlert message={dbError} onRetry={reloadDbs} />}

        {!dbLoading && !dbError && (!databases || databases.length === 0) && (
          <EmptyState
            icon="🐘"
            title="No databases found"
            description="This may not be a PostgreSQL container, or the user 'postgres' has no accessible databases."
          />
        )}

        {!dbLoading && !dbError && databases && databases.length > 0 && (
          <div className="divide-y divide-zinc-800/60">
            {databases.map((db) => (
              <div key={db} className="flex items-center justify-between py-3 group">
                <div className="flex items-center gap-3">
                  <div className="w-2 h-2 rounded-full bg-emerald-400/60" />
                  <span className="font-mono text-sm text-zinc-200">{db}</span>
                </div>
                <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                  {OPERATIONS.filter(o => o.id !== 'create').map((op) => (
                    <button
                      key={op.id}
                      onClick={() => { setActiveOp({ ...op, _presetDb: db }) }}
                      title={op.label}
                      className={`px-2 py-1 rounded-md text-xs font-medium transition-colors ${
                        op.variant === 'danger'
                          ? 'text-red-400 hover:bg-red-500/15'
                          : 'text-zinc-400 hover:bg-zinc-700 hover:text-zinc-100'
                      }`}
                    >
                      {op.icon} {op.label}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* Modal */}
      {activeOp && (
        <OperationModal
          op={activeOp}
          container={containerName}
          databases={activeOp._presetDb ? [activeOp._presetDb] : databases}
          backups={backups}
          onClose={() => setActiveOp(null)}
          onRun={handleRun}
        />
      )}
    </div>
  )
}

