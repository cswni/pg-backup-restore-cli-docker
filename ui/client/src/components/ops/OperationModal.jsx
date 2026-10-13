import React, { useState } from 'react'
import { Button, DbNameInput, Toggle, DB_NAME_PATTERN, dropTargetHint } from '../UI'
import ExportStorageOptions, { exportSuffix } from '../storage/ExportStorageOptions'
import { useAuth } from '../../lib/auth'

// Database operations offered for a container or a direct database server.
export const OPERATIONS = [
  { id: 'export',  label: 'Export',   icon: '📤', variant: 'primary',   desc: 'Dump database to /backups' },
  { id: 'create',  label: 'Create',   icon: '➕', variant: 'primary',   desc: 'Create a new database' },
  { id: 'unblock', label: 'Unblock',  icon: '🔓', variant: 'secondary', desc: 'Terminate active connections' },
  { id: 'restore', label: 'Restore',  icon: '♻️', variant: 'secondary', desc: 'Restore a dump into any database name' },
  { id: 'delete',  label: 'Delete',   icon: '🗑️', variant: 'danger',    desc: 'Drop database (irreversible!)' },
]

const SELECT_CLASS = 'w-full bg-zinc-800 border border-zinc-700 focus:border-emerald-500 rounded-lg px-3 py-2 text-sm font-mono text-zinc-100 outline-hidden transition-colors'
const LABEL_CLASS = 'block text-xs text-zinc-500 mb-1 font-medium uppercase tracking-wider'

function DatabaseField({ op, databases, db, setDb, customDb, setCustomDb, exists }) {
  const isRestore = op.id === 'restore'
  if (op.id !== 'create' && !isRestore) {
    return (
      <select value={db} onChange={(e) => setDb(e.target.value)} className={SELECT_CLASS}>
        <option value="">— select database —</option>
        {(databases || []).map((d) => <option key={d} value={d}>{d}</option>)}
      </select>
    )
  }
  return (
    <>
      <DbNameInput
        id={`op-${op.id}-db`}
        value={customDb}
        onChange={setCustomDb}
        options={isRestore ? databases : []}
        placeholder={isRestore ? 'existing or new database name' : 'new_database_name'}
      />
      {isRestore && customDb && (
        <p className="text-xs text-zinc-500 mt-1">
          {exists ? 'Database exists on this server.' : 'Database will be created.'}
        </p>
      )}
    </>
  )
}

function ExportNameField({ db, outputName, setOutputName, storageOptions, fileExtension }) {
  return (
    <div>
      <label className={LABEL_CLASS}>
        Export Name <span className="text-zinc-600 normal-case">(optional — defaults to database name)</span>
      </label>
      <DbNameInput id="op-export-name" value={outputName} onChange={setOutputName} placeholder={db || 'e.g. premas_qa'} />
      <p className="text-xs text-zinc-500 mt-1 font-mono">
        → {(outputName || db || '<name>')}_DD-MM-YYYY_HH_MM_SS{exportSuffix(storageOptions, fileExtension)}
      </p>
    </div>
  )
}

function DangerConfirm({ db, confirm, setConfirm }) {
  return (
    <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-4">
      <p className="text-xs text-red-400 mb-2 font-medium">
        ⚠️ This will permanently drop <strong>{db}</strong>. Type the database name to confirm:
      </p>
      <input
        type="text"
        placeholder={db}
        value={confirm}
        onChange={(e) => setConfirm(e.target.value)}
        className="w-full bg-zinc-900 border border-red-500/30 focus:border-red-500 rounded-lg px-3 py-2 text-sm font-mono text-red-300 placeholder-red-900 outline-hidden transition-colors"
      />
    </div>
  )
}

/**
 * Dialog for one operation. `targetLabel` describes where it runs (container
 * or server); `onRun(opId, params)` receives { database, file, outputName, options, dropExisting }.
 * `fileExtension` is the raw dump extension of the target's engine ('.sql', '.archive').
 */
export default function OperationModal({ op, targetLabel, databases, presetDb, backups, fileExtension = '.sql', onClose, onRun }) {
  const [db, setDb] = useState(presetDb || '')
  const [customDb, setCustomDb] = useState(presetDb || '')
  const [file, setFile] = useState('')
  const [outputName, setOutputName] = useState('')
  const [dropExisting, setDropExisting] = useState(false)
  const [confirm, setConfirm] = useState('')
  const [running, setRunning] = useState(false)
  const [storageOptions, setStorageOptions] = useState(null)
  // Storage overrides are admin-only (the server applies defaults for others)
  const { isAdmin } = useAuth()

  const isRestore = op.id === 'restore'
  const isExport = op.id === 'export'
  const isDanger = op.id === 'delete'
  const finalDb = op.id === 'create' || isRestore ? customDb : db
  const exists = (databases || []).includes(finalDb)

  const valid =
    DB_NAME_PATTERN.test(finalDb) &&
    (!isExport || !outputName || DB_NAME_PATTERN.test(outputName)) &&
    (!isRestore || !!file) &&
    (!isDanger || confirm === finalDb)

  async function submit() {
    if (!valid) return
    setRunning(true)
    try {
      await onRun(op.id, {
        database: finalDb,
        file: isRestore ? file : undefined,
        outputName: isExport && outputName ? outputName : undefined,
        options: isExport && storageOptions ? storageOptions : undefined,
        dropExisting: isRestore ? dropExisting : undefined,
      })
    } finally {
      setRunning(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-xs p-4">
      <div className="bg-zinc-900 border border-zinc-700 rounded-2xl w-full max-w-md shadow-2xl max-h-[95vh] overflow-y-auto">
        <div className="flex items-center gap-3 px-6 py-5 border-b border-zinc-800">
          <span className="text-2xl">{op.icon}</span>
          <div>
            <p className="font-semibold text-zinc-100">{op.label}</p>
            <p className="text-xs text-zinc-500 mt-0.5">{op.desc}</p>
          </div>
          <button onClick={onClose} className="ml-auto text-zinc-600 hover:text-zinc-300 text-xl leading-none">✕</button>
        </div>

        <div className="px-6 py-5 space-y-4">
          <div>
            <label className={LABEL_CLASS}>Target</label>
            <p className="font-mono text-sm text-emerald-400 bg-zinc-800 rounded-lg px-3 py-2 truncate">{targetLabel}</p>
          </div>

          <div>
            <label className={LABEL_CLASS}>{isRestore ? 'Target Database' : 'Database'}</label>
            <DatabaseField op={op} databases={databases} db={db} setDb={setDb}
              customDb={customDb} setCustomDb={setCustomDb} exists={exists} />
          </div>

          {isExport && (
            <ExportNameField db={db} outputName={outputName} setOutputName={setOutputName}
              storageOptions={storageOptions} fileExtension={fileExtension} />
          )}

          {/* Export: compression / encryption / cloud copies */}
          {isExport && isAdmin && <ExportStorageOptions onChange={setStorageOptions} />}

          {isRestore && (
            <Toggle
              danger
              checked={dropExisting}
              onChange={setDropExisting}
              label="Drop target database before restore"
              hint={dropTargetHint(finalDb, exists, dropExisting)}
            />
          )}

          {isRestore && (
            <div>
              <label className={LABEL_CLASS}>Dump File</label>
              <select value={file} onChange={(e) => setFile(e.target.value)} className={SELECT_CLASS}>
                <option value="">— select a backup —</option>
                {(backups || []).map((b) => <option key={b.name} value={b.name}>{b.name}</option>)}
              </select>
            </div>
          )}

          {isDanger && finalDb && <DangerConfirm db={finalDb} confirm={confirm} setConfirm={setConfirm} />}
        </div>

        <div className="flex justify-end gap-2 px-6 py-4 border-t border-zinc-800">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant={isRestore && dropExisting ? 'danger' : op.variant} disabled={!valid || running} onClick={submit}>
            {running ? <><span className="animate-spin">⟳</span> Running…</> : `Run ${op.label}`}
          </Button>
        </div>
      </div>
    </div>
  )
}
