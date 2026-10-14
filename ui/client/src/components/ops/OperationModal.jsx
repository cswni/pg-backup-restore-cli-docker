import React, { useState, useId } from 'react'
import { Button, DbNameInput, Toggle, DB_NAME_PATTERN, dropTargetHint } from '../UI'
import ExportStorageOptions, { exportSuffix } from '../storage/ExportStorageOptions'
import { useAuth } from '../../lib/auth'
import Modal, { ModalFooter } from '../Modal'

// Database operations offered for a container or a direct database server.
export const OPERATIONS = [
  { id: 'export',  label: 'Export',   icon: '📤', variant: 'primary',   desc: 'Dump database to /backups' },
  { id: 'create',  label: 'Create',   icon: '➕', variant: 'primary',   desc: 'Create a new database' },
  { id: 'unblock', label: 'Unblock',  icon: '🔓', variant: 'secondary', desc: 'Terminate active connections' },
  { id: 'restore', label: 'Restore',  icon: '♻️', variant: 'secondary', desc: 'Restore a dump into any database name' },
  { id: 'delete',  label: 'Delete',   icon: '🗑️', variant: 'danger',    desc: 'Drop database (irreversible!)' },
]

const SELECT_CLASS = 'w-full bg-zinc-800 border border-zinc-500 focus:border-emerald-500 rounded-lg px-3 py-2 text-sm font-mono text-zinc-100 outline-hidden transition-colors'
const LABEL_CLASS = 'block text-xs text-zinc-400 mb-1 font-medium uppercase tracking-wider'

function DatabaseField({ id, op, databases, db, setDb, customDb, setCustomDb, exists }) {
  const isRestore = op.id === 'restore'
  if (op.id !== 'create' && !isRestore) {
    return (
      <select id={id} value={db} onChange={(e) => setDb(e.target.value)} className={SELECT_CLASS}>
        <option value="">Select a database</option>
        {(databases || []).map((d) => <option key={d} value={d}>{d}</option>)}
      </select>
    )
  }
  return (
    <>
      <DbNameInput
        id={id}
        value={customDb}
        onChange={setCustomDb}
        options={isRestore ? databases : []}
        placeholder={isRestore ? 'existing or new database name' : 'new_database_name'}
      />
      {isRestore && customDb && (
        <p className="text-xs text-zinc-400 mt-1">
          {exists ? 'Database exists on this server.' : 'Database will be created.'}
        </p>
      )}
    </>
  )
}

function ExportNameField({ db, outputName, setOutputName, storageOptions, fileExtension }) {
  const id = useId()
  return (
    <div>
      <label htmlFor={id} className={LABEL_CLASS}>
        Export Name <span className="text-zinc-400 normal-case">(optional, defaults to the database name)</span>
      </label>
      <DbNameInput id={id} value={outputName} onChange={setOutputName} placeholder={db || 'e.g. premas_qa'} />
      <p className="text-xs text-zinc-400 mt-1 font-mono">
        → {(outputName || db || '<name>')}_DD-MM-YYYY_HH_MM_SS{exportSuffix(storageOptions, fileExtension)}
      </p>
    </div>
  )
}

function DangerConfirm({ db, confirm, setConfirm }) {
  const id = useId()
  return (
    <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-4">
      <label htmlFor={id} className="block text-xs text-red-400 mb-2 font-medium">
        ⚠️ This will permanently drop <strong>{db}</strong>. Type the database name to confirm:
      </label>
      <input
        id={id}
        type="text"
        placeholder={db}
        value={confirm}
        onChange={(e) => setConfirm(e.target.value)}
        className="w-full bg-zinc-900 border border-red-500/30 focus:border-red-500 rounded-lg px-3 py-2 text-sm font-mono text-red-300 placeholder-zinc-400 outline-hidden transition-colors"
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
  const uid = useId()

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
    <Modal icon={op.icon} title={op.label} subtitle={op.desc} onClose={onClose}>
      <div className="px-6 py-5 space-y-4">
        <div>
          <p className={LABEL_CLASS}>Target</p>
          <p className="font-mono text-sm text-emerald-400 bg-zinc-800 rounded-lg px-3 py-2 truncate">{targetLabel}</p>
        </div>

        <div>
          <label htmlFor={`${uid}-db`} className={LABEL_CLASS}>{isRestore ? 'Target Database' : 'Database'}</label>
          <DatabaseField id={`${uid}-db`} op={op} databases={databases} db={db} setDb={setDb}
            customDb={customDb} setCustomDb={setCustomDb} exists={exists} />
        </div>

        {isExport && (
          <ExportNameField db={db} outputName={outputName} setOutputName={setOutputName}
            storageOptions={storageOptions} fileExtension={fileExtension} />
        )}

        {/* Storage overrides (compression, encryption, cloud copies) are admin-only */}
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
            <label htmlFor={`${uid}-file`} className={LABEL_CLASS}>Dump File</label>
            <select id={`${uid}-file`} value={file} onChange={(e) => setFile(e.target.value)} className={SELECT_CLASS}>
              <option value="">Select a backup</option>
              {(backups || []).map((b) => <option key={b.name} value={b.name}>{b.name}</option>)}
            </select>
          </div>
        )}

        {isDanger && finalDb && <DangerConfirm db={finalDb} confirm={confirm} setConfirm={setConfirm} />}
      </div>

      <ModalFooter>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant={isRestore && dropExisting ? 'danger' : op.variant} disabled={!valid || running} onClick={submit}>
          {running ? <><span aria-hidden="true" className="animate-spin">⟳</span> Running…</> : `Run ${op.label}`}
        </Button>
      </ModalFooter>
    </Modal>
  )
}
