import React, { useState, useRef, useEffect } from 'react'
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

function UploadRestoreModal({ onClose, onDone }) {
  const { data: containers, loading: loadingContainers } = useFetch(api.containers.list)
  const [container, setContainer] = useState('')
  const [databases, setDatabases] = useState([])
  const [loadingDbs, setLoadingDbs] = useState(false)
  const [db, setDb] = useState('')
  const [file, setFile] = useState(null)
  const [restoreNow, setRestoreNow] = useState(true)
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState(0)
  const fileRef = useRef()

  // Fetch databases when container changes
  useEffect(() => {
    setDb('')
    setDatabases([])
    if (!container) return
    setLoadingDbs(true)
    api.containers.databases(container)
      .then(setDatabases)
      .catch(() => setDatabases([]))
      .finally(() => setLoadingDbs(false))
  }, [container])

  async function submit() {
    if (!file) return
    if (restoreNow && (!container || !db)) return
    setRunning(true)
    setProgress(0)
    try {
      const fd = new FormData()
      fd.append('file', file)
      if (restoreNow) {
        fd.append('restore', 'true')
        fd.append('container', container)
        fd.append('database', db)
      }
      const result = await api.backups.upload(fd)
      onDone(result)
    } finally {
      setRunning(false)
    }
  }

  const canSubmit = file && (!restoreNow || (container && db)) && !running

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
      <div className="bg-zinc-900 border border-zinc-700 rounded-2xl w-full max-w-lg shadow-2xl">
        {/* Header */}
        <div className="flex items-center gap-3 px-6 py-5 border-b border-zinc-800">
          <span className="text-2xl">⬆️</span>
          <div>
            <p className="font-semibold text-zinc-100">Upload &amp; Restore</p>
            <p className="text-xs text-zinc-500 mt-0.5">Upload a .sql dump file and optionally restore it immediately</p>
          </div>
          <button onClick={onClose} className="ml-auto text-zinc-600 hover:text-zinc-300 text-xl leading-none">✕</button>
        </div>

        <div className="px-6 py-5 space-y-5">
          {/* File drop zone */}
          <div
            className={`relative flex flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed py-8 px-4 cursor-pointer transition-colors
              ${file ? 'border-emerald-500/60 bg-emerald-500/5' : 'border-zinc-700 hover:border-zinc-500 bg-zinc-800/30'}`}
            onClick={() => fileRef.current?.click()}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault()
              const f = e.dataTransfer.files[0]
              if (f && f.name.endsWith('.sql')) setFile(f)
            }}
          >
            <input
              ref={fileRef}
              type="file"
              accept=".sql"
              className="hidden"
              onChange={(e) => setFile(e.target.files[0] || null)}
            />
            {file ? (
              <>
                <span className="text-3xl">📄</span>
                <div className="text-center">
                  <p className="text-sm font-mono text-emerald-400">{file.name}</p>
                  <p className="text-xs text-zinc-500 mt-0.5">{(file.size / 1024).toFixed(1)} KB</p>
                </div>
                <button
                  className="text-xs text-zinc-500 hover:text-red-400 transition-colors"
                  onClick={(e) => { e.stopPropagation(); setFile(null) }}
                >
                  ✕ Remove
                </button>
              </>
            ) : (
              <>
                <span className="text-3xl text-zinc-600">📂</span>
                <div className="text-center">
                  <p className="text-sm text-zinc-400">Drop a <span className="font-mono">.sql</span> file here</p>
                  <p className="text-xs text-zinc-600 mt-1">or click to browse</p>
                </div>
              </>
            )}
          </div>

          {/* Restore now toggle */}
          <label className="flex items-center gap-3 cursor-pointer select-none group">
            <div
              className={`relative w-10 h-5 rounded-full transition-colors ${restoreNow ? 'bg-emerald-500' : 'bg-zinc-700'}`}
              onClick={() => setRestoreNow(!restoreNow)}
            >
              <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${restoreNow ? 'translate-x-5' : ''}`} />
            </div>
            <span className="text-sm text-zinc-300 group-hover:text-zinc-100 transition-colors">Restore immediately after upload</span>
          </label>

          {/* Container + DB selectors (shown only when restore=true) */}
          {restoreNow && (
            <div className="space-y-4 pt-1">
              <div>
                <label className="block text-xs text-zinc-500 mb-1 font-medium uppercase tracking-wider">Target Container</label>
                {loadingContainers ? <Spinner size="sm" /> : (
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
                <label className="block text-xs text-zinc-500 mb-1 font-medium uppercase tracking-wider">
                  Database Name
                  {loadingDbs && <span className="ml-2 text-zinc-600 normal-case tracking-normal">loading…</span>}
                </label>
                {databases.length > 0 ? (
                  <select
                    value={db}
                    onChange={(e) => setDb(e.target.value)}
                    className="w-full bg-zinc-800 border border-zinc-700 focus:border-emerald-500 rounded-lg px-3 py-2 text-sm font-mono text-zinc-100 outline-none transition-colors"
                  >
                    <option value="">— select database —</option>
                    {databases.map((d) => (
                      <option key={d} value={d}>{d}</option>
                    ))}
                  </select>
                ) : (
                  <input
                    type="text"
                    value={db}
                    placeholder={container ? 'Type database name…' : 'Select a container first'}
                    onChange={(e) => setDb(e.target.value)}
                    className="w-full bg-zinc-800 border border-zinc-700 focus:border-emerald-500 rounded-lg px-3 py-2 text-sm font-mono text-zinc-100 placeholder-zinc-600 outline-none transition-colors"
                  />
                )}
              </div>
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 px-6 py-4 border-t border-zinc-800">
          <Button variant="ghost" onClick={onClose} disabled={running}>Cancel</Button>
          <Button variant="primary" disabled={!canSubmit} onClick={submit}>
            {running
              ? <><span className="animate-spin inline-block mr-1">⟳</span> Uploading…</>
              : restoreNow ? '⬆️ Upload & Restore' : '⬆️ Upload'}
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
  const [showUpload, setShowUpload] = useState(false)
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

  function handleUploadDone(result) {
    setShowUpload(false)
    if (result.jobId) {
      navigate(`/jobs/${result.jobId}`)
    } else {
      showToast('success', `Uploaded: ${result.filename}`)
      reload()
    }
  }

  const totalSize = (backups || []).reduce((a, b) => a + b.size, 0)

  return (
    <div className="p-8">
      <PageHeader
        title="Backups"
        subtitle={backups ? `${backups.length} files · ${formatBytes(totalSize)} total` : 'Dump files in /backups'}
        action={
          <div className="flex gap-2">
            <Button variant="primary" size="sm" onClick={() => setShowUpload(true)}>⬆️ Upload &amp; Restore</Button>
            <Button variant="secondary" size="sm" onClick={reload}>↻ Refresh</Button>
          </div>
        }
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

      {showUpload && (
        <UploadRestoreModal
          onClose={() => setShowUpload(false)}
          onDone={handleUploadDone}
        />
      )}
    </div>
  )
}
