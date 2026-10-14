import React, { useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { useFetch } from '../../hooks/useFetch'
import { api } from '../../lib/api'
import { useAuth } from '../../lib/auth'
import { Database, TableProperties } from 'lucide-react'
import { Card, Spinner, ErrorAlert, EmptyState, Toast, Icon } from '../UI'
import { useEngines, engineInfo, isCompatibleBackup } from '../../lib/engines'
import OperationModal, { OPERATIONS } from './OperationModal'
import { explorerHref } from '../explorer/useExplorerTarget'

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
          <Icon as={op.icon} className="size-6" />
          {op.label}
        </button>
      ))}
    </div>
  )
}

function DatabaseRow({ db, operations, onSelect, target }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 py-3 group">
      <span className="min-w-0 font-mono text-sm text-zinc-200 break-all">{db}</span>
      <div className="flex flex-wrap gap-1 opacity-100 md:opacity-0 md:group-hover:opacity-100 md:focus-within:opacity-100 transition-opacity">
        <Link
          to={explorerHref({ ...target, database: db })}
          className="inline-flex items-center gap-1.5 px-2 py-1 min-h-[44px] md:min-h-0 rounded-md text-xs font-medium text-zinc-400 hover:bg-zinc-700 hover:text-zinc-100 transition-colors"
        >
          <Icon as={TableProperties} className="size-3.5" /> Explore
        </Link>
        {operations.filter((o) => o.id !== 'create').map((op) => (
          <button
            key={op.id}
            onClick={() => onSelect({ ...op, presetDb: db })}
            title={op.label}
            className={`inline-flex items-center gap-1.5 px-2 py-1 min-h-[44px] md:min-h-0 rounded-md text-xs font-medium transition-colors ${
              op.variant === 'danger' ? 'text-red-400 hover:bg-red-500/15' : 'text-zinc-400 hover:bg-zinc-700 hover:text-zinc-100'
            }`}
          >
            <Icon as={op.icon} className="size-3.5" /> {op.label}
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
      {toast && <Toast type={toast.type} message={toast.msg} />}
      <OperationGrid operations={operations} onSelect={setActiveOp} />

      <Card>
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 mb-4">
          <h2 className="font-semibold text-zinc-200">Databases</h2>
          <span className="text-xs text-zinc-400">Click an operation above to act on a database</span>
        </div>

        {loading && <div className="flex justify-center py-10"><Spinner /></div>}
        {error && <ErrorAlert message={error} onRetry={reload} />}

        {!loading && !error && (!dbs || dbs.length === 0) && (
          <EmptyState icon={Database} title="No databases found" description={emptyDescription} />
        )}

        {!loading && !error && dbs?.length > 0 && (
          <div className="divide-y divide-zinc-800/60">
            {dbs.map((db) => <DatabaseRow key={db} db={db} operations={operations} onSelect={setActiveOp} target={target} />)}
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
