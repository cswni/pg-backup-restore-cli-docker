import React, { useState } from 'react'
import { useNavigate } from 'react-router'
import { useFetch } from '../../hooks/useFetch'
import { api } from '../../lib/api'
import { useAuth } from '../../lib/auth'
import { Card, Spinner, ErrorAlert, EmptyState } from '../UI'
import { useEngines, engineInfo, isCompatibleBackup } from '../../lib/engines'
import OperationModal, { OPERATIONS } from './OperationModal'

function Toast({ toast }) {
  if (!toast) return null
  const cls = toast.type === 'error'
    ? 'bg-red-500/10 border-red-500/20 text-red-400'
    : 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400'
  return (
    <div className={`mb-6 flex items-center gap-2 px-4 py-3 rounded-xl text-sm border ${cls}`}>
      <span>{toast.type === 'error' ? '⚠️' : '✅'}</span>
      {toast.msg}
    </div>
  )
}

/** Restores and schema changes are admin-only (the API enforces it too). */
function visibleOperations(operations, isAdmin) {
  return isAdmin ? operations : operations.filter((op) => op.id === 'export')
}

function OperationGrid({ operations, onSelect }) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 mb-8">
      {operations.map((op) => (
        <button
          key={op.id}
          onClick={() => onSelect(op)}
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
  )
}

function DatabaseRow({ db, operations, onSelect }) {
  return (
    <div className="flex items-center justify-between py-3 group">
      <div className="flex items-center gap-3">
        <div className="w-2 h-2 rounded-full bg-emerald-400/60" />
        <span className="font-mono text-sm text-zinc-200">{db}</span>
      </div>
      <div className="flex gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
        {operations.filter((o) => o.id !== 'create').map((op) => (
          <button
            key={op.id}
            onClick={() => onSelect({ ...op, presetDb: db })}
            title={op.label}
            className={`px-2 py-1 rounded-md text-xs font-medium transition-colors ${
              op.variant === 'danger' ? 'text-red-400 hover:bg-red-500/15' : 'text-zinc-400 hover:bg-zinc-700 hover:text-zinc-100'
            }`}
          >
            {op.icon} {op.label}
          </button>
        ))}
      </div>
    </div>
  )
}

/**
 * Operations grid + database list + operation dialog, shared by containers
 * and direct database servers.
 *
 * @param {object} props
 * @param {{ serverId: string, engine: string, container?: string }} props.target  merged into every /api/ops request
 * @param {string} props.targetLabel   shown in the dialog
 * @param {{ data: string[]|null, loading: boolean, error: string|null, reload: Function }} props.databases
 * @param {string} props.emptyDescription
 * @param {string} props.kind  server kind ('docker' | 'direct'), selects the driver capabilities
 */
export default function DatabaseWorkspace({ target, targetLabel, databases, emptyDescription, kind }) {
  const navigate = useNavigate()
  const { data: allBackups } = useFetch(api.backups.list)
  const engines = useEngines()
  const { isAdmin } = useAuth()
  const [activeOp, setActiveOp] = useState(null)
  const [toast, setToast] = useState(null)
  const { data: dbs, loading, error, reload } = databases

  // Only what this engine's driver supports, and only backups it can restore
  const { operations: supported, fileExtension } = engineInfo(engines, target.engine, kind)
  const operations = visibleOperations(OPERATIONS.filter((op) => supported.includes(op.id)), isAdmin)
  const backups = (allBackups || []).filter((b) => isCompatibleBackup(b.name, b.engine, target.engine))

  async function handleRun(operation, params) {
    try {
      const { jobId } = await api.ops.run(operation, { ...target, ...params })
      setActiveOp(null)
      navigate(`/jobs/${jobId}`)
    } catch (e) {
      setToast({ type: 'error', msg: e.message })
      setTimeout(() => setToast(null), 5000)
    }
  }

  const modalDatabases = activeOp?.presetDb && activeOp.id !== 'restore' ? [activeOp.presetDb] : dbs

  return (
    <>
      <Toast toast={toast} />
      <OperationGrid operations={operations} onSelect={setActiveOp} />

      <Card>
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-semibold text-zinc-200">Databases</h2>
          <span className="text-xs text-zinc-600">Click an operation above to act on a database</span>
        </div>

        {loading && <div className="flex justify-center py-10"><Spinner /></div>}
        {error && <ErrorAlert message={error} onRetry={reload} />}

        {!loading && !error && (!dbs || dbs.length === 0) && (
          <EmptyState icon="🐘" title="No databases found" description={emptyDescription} />
        )}

        {!loading && !error && dbs?.length > 0 && (
          <div className="divide-y divide-zinc-800/60">
            {dbs.map((db) => <DatabaseRow key={db} db={db} operations={operations} onSelect={setActiveOp} />)}
          </div>
        )}
      </Card>

      {activeOp && (
        <OperationModal
          op={activeOp}
          targetLabel={targetLabel}
          databases={modalDatabases}
          presetDb={activeOp.presetDb}
          backups={backups}
          fileExtension={fileExtension}
          onClose={() => setActiveOp(null)}
          onRun={handleRun}
        />
      )}
    </>
  )
}
