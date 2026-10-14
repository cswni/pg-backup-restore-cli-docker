import React, { useState, useRef, useEffect, useId } from 'react'
import { api } from '../../lib/api'
import { useAuth } from '../../lib/auth'
import { ErrorAlert, Button, Toggle, ProgressBar } from '../UI'
import Modal, { ModalFooter } from '../Modal'
import RestoreTargetFields, { useRestoreTarget } from '../servers/RestoreTarget'

// Dumps the server accepts: plain SQL or MongoDB archive, optionally gzipped and/or encrypted
const UPLOAD_NAME = /\.(sql|archive)(\.gz)?(\.enc)?$/i

export function formatBytes(b) {
  if (b == null) return 'unknown'
  if (b < 1024) return `${b} B`
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`
  return `${(b / 1024 / 1024).toFixed(2)} MB`
}

function parseDbName(filename) {
  // e.g. mydb_12-03-2025_14_30_00.sql gives mydb
  const m = filename.match(/^(.+?)_\d{2}-\d{2}-\d{4}/)
  return m ? m[1] : filename.replace(/\.(sql|archive)$/, '')
}

const Running = ({ children }) => <><span aria-hidden="true" className="animate-spin inline-block">⟳</span> {children}</>

export function RestoreModal({ backup, onClose, onRestore }) {
  const target = useRestoreTarget(parseDbName(backup.name), { name: backup.name, engine: backup.engine })
  const [running, setRunning] = useState(false)

  const canSubmit = target.ready && !running

  async function submit() {
    if (!canSubmit) return
    setRunning(true)
    try {
      await onRestore({ ...target.payload, file: backup.name })
    } finally {
      setRunning(false)
    }
  }

  return (
    <Modal icon="♻️" title="Restore" subtitle={backup.name} subtitleClassName="font-mono break-all" onClose={onClose}>
      <div className="px-6 py-5 space-y-4">
        <RestoreTargetFields id="restore-db" target={target} />
      </div>
      <ModalFooter>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant={target.dropExisting ? 'danger' : 'primary'} disabled={!canSubmit} onClick={submit}>
          {running ? <Running>Running…</Running> : 'Restore'}
        </Button>
      </ModalFooter>
    </Modal>
  )
}

/**
 * File picker that works by keyboard (a real <label> for a visually hidden
 * input) and by drag and drop.
 */
function DropZone({ file, running, onPick }) {
  const inputId = useId()
  const [dragging, setDragging] = useState(false)
  const [rejected, setRejected] = useState(null)

  function pick(f) {
    if (f && !UPLOAD_NAME.test(f.name)) {
      setRejected(f.name)
      return
    }
    setRejected(null)
    onPick(f)
  }

  const border = file ? 'border-emerald-500/60 bg-emerald-500/5'
    : dragging ? 'border-emerald-500 bg-zinc-800/50' : 'border-zinc-500 hover:border-zinc-400 bg-zinc-800/30'

  return (
    <div
      className={`rounded-xl border-2 border-dashed transition-colors has-[input:focus-visible]:ring-2 has-[input:focus-visible]:ring-emerald-500 ${border}`}
      onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault()
        setDragging(false)
        if (!running) pick(e.dataTransfer.files[0] || null)
      }}
    >
      <input
        id={inputId}
        type="file"
        accept=".sql,.archive,.gz,.enc"
        className="sr-only"
        disabled={running}
        onChange={(e) => pick(e.target.files[0] || null)}
      />
      {file ? (
        <div className="flex flex-col items-center gap-3 py-6 px-4 text-center">
          <span aria-hidden="true" className="text-3xl">📄</span>
          <div>
            <p className="text-sm font-mono text-emerald-400 break-all">{file.name}</p>
            <p className="text-xs text-zinc-400 mt-0.5">{formatBytes(file.size)}</p>
          </div>
          <div className="flex flex-wrap justify-center gap-2">
            <label htmlFor={inputId} className={`min-h-[44px] inline-flex items-center px-3 text-xs text-zinc-400 hover:text-zinc-100 ${running ? 'opacity-40 pointer-events-none' : 'cursor-pointer'}`}>
              Choose another file
            </label>
            <button type="button" disabled={running} onClick={() => onPick(null)}
              className="min-h-[44px] px-3 text-xs text-zinc-400 hover:text-red-400 transition-colors disabled:opacity-40">
              ✕ Remove
            </button>
          </div>
        </div>
      ) : (
        <label htmlFor={inputId} className="flex flex-col items-center justify-center gap-3 py-8 px-4 text-center cursor-pointer">
          <span aria-hidden="true" className="text-3xl text-zinc-400">📂</span>
          <span className="text-sm text-zinc-400">
            Drop a <span className="font-mono">.sql</span> or <span className="font-mono">.archive</span> file
            (optionally <span className="font-mono">.gz</span> or <span className="font-mono">.enc</span>) here
          </span>
          <span className="text-xs text-zinc-400">or click to browse</span>
        </label>
      )}
      {rejected && (
        <p role="alert" className="px-4 pb-3 text-xs text-red-400 text-center break-all">
          {rejected} is not a .sql or .archive dump (optionally .gz or .enc).
        </p>
      )}
    </div>
  )
}

export function UploadRestoreModal({ onClose, onDone }) {
  const { isAdmin } = useAuth()
  const [file, setFile] = useState(null)
  // Uploads have no catalog row: the engine is inferred from the extension
  const target = useRestoreTarget('', file ? { name: file.name } : null)
  // Restores are admin-only; other users can still upload
  const [restoreNow, setRestoreNow] = useState(isAdmin)
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState(0)
  const [uploadError, setUploadError] = useState(null)
  const abortRef = useRef(null)

  // Abort an in-flight upload if the dialog unmounts
  useEffect(() => () => abortRef.current?.abort(), [])

  function pickFile(f) {
    setFile(f)
    setUploadError(null)
    // Default the target to the dump's database name; user can rename it
    if (f && !target.db) target.setDb(parseDbName(f.name))
  }

  const canSubmit = file && (!restoreNow || target.ready) && !running

  async function submit() {
    if (!canSubmit) return
    setRunning(true)
    setProgress(0)
    setUploadError(null)
    abortRef.current = new AbortController()
    try {
      const result = await api.backups.upload(file, {
        restore: restoreNow ? target.payload : undefined,
        onProgress: setProgress,
        signal: abortRef.current.signal,
      })
      onDone(result)
    } catch (e) {
      setUploadError(e.message)
    } finally {
      abortRef.current = null
      setRunning(false)
    }
  }

  function cancel() {
    if (abortRef.current) abortRef.current.abort()
    else onClose()
  }

  return (
    <Modal
      icon="⬆️"
      title={isAdmin ? 'Upload & Restore' : 'Upload'}
      subtitle={isAdmin
        ? 'Upload a .sql dump or MongoDB .archive and optionally restore it immediately'
        : 'Upload a .sql dump or MongoDB .archive'}
      size="lg"
      onClose={onClose}
    >
      <div className="px-6 py-5 space-y-5">
        <DropZone file={file} running={running} onPick={pickFile} />

        {(running || progress > 0) && <ProgressBar percent={progress} />}
        {uploadError && <ErrorAlert message={uploadError} />}

        {isAdmin && <Toggle checked={restoreNow} onChange={setRestoreNow} label="Restore immediately after upload" />}

        {restoreNow && (
          <div className="space-y-4 pt-1">
            <RestoreTargetFields id="upload-db" target={target} />
          </div>
        )}
      </div>

      <ModalFooter>
        <Button variant="ghost" onClick={cancel}>{running ? 'Cancel upload' : 'Cancel'}</Button>
        <Button variant={restoreNow && target.dropExisting ? 'danger' : 'primary'} disabled={!canSubmit} onClick={submit}>
          {running
            ? <Running>Uploading… {progress}%</Running>
            : restoreNow ? '⬆️ Upload & Restore' : '⬆️ Upload'}
        </Button>
      </ModalFooter>
    </Modal>
  )
}
