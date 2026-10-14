import React, { useState } from 'react'
import { useNavigate } from 'react-router'
import { useFetch } from '../hooks/useFetch'
import { api } from '../lib/api'
import { useAuth } from '../lib/auth'
import { PageHeader, Card, Spinner, ErrorAlert, EmptyState, Button, Toast } from '../components/UI'
import BackupBadges from '../components/storage/BackupBadges'
import { RestoreModal, UploadRestoreModal, formatBytes } from '../components/backups/BackupDialogs'

function formatDate(ms) {
  return new Date(ms).toLocaleString()
}

export default function Backups() {
  const { data: backups, loading, error, reload } = useFetch(api.backups.list)
  const [restoreTarget, setRestoreTarget] = useState(null)
  const [deleting, setDeleting] = useState(null)
  const [toast, setToast] = useState(null)
  const [showUpload, setShowUpload] = useState(false)
  const navigate = useNavigate()
  const { isAdmin } = useAuth()

  const showToast = (type, msg) => {
    setToast({ type, msg })
    setTimeout(() => setToast(null), 4000)
  }

  async function handleDelete(backup) {
    const filename = backup.name
    const remote = backup.locations?.length || 0
    if (remote && !window.confirm(backup.local === false
      ? `Delete the ${remote} remote cop${remote === 1 ? 'y' : 'ies'} of ${filename}? This cannot be undone.`
      : `Delete ${filename} locally AND its ${remote} remote cop${remote === 1 ? 'y' : 'ies'}?`)) return
    setDeleting(filename)
    try {
      // Remote copies first, so they are never left untracked
      if (remote) await api.storage.deleteRemoteCopies(filename)
      if (backup.local !== false) await api.backups.delete(filename)
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

  const totalSize = (backups || []).filter((b) => b.local !== false).reduce((a, b) => a + b.size, 0)

  return (
    <div className="p-4 md:p-8">
      <PageHeader
        title="Backups"
        subtitle={backups ? `${backups.length} files · ${formatBytes(totalSize)} total` : 'Dump files in /backups'}
        action={
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" size="sm" onClick={() => setShowUpload(true)}>{isAdmin ? <>⬆️ Upload &amp; Restore</> : '⬆️ Upload'}</Button>
            <Button variant="secondary" size="sm" onClick={reload}>↻ Refresh</Button>
          </div>
        }
      />

      {toast && <Toast type={toast.type} message={toast.msg} />}

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
                <tr className="text-left text-xs text-zinc-400 uppercase tracking-wider border-b border-zinc-800 bg-zinc-950/50">
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
                      <div className="flex flex-wrap items-center gap-2">
                        <span aria-hidden="true" className="text-base">{b.local === false ? '☁️' : '📄'}</span>
                        <span className="font-mono text-xs text-zinc-300">{b.name}</span>
                        <BackupBadges backup={b} />
                      </div>
                    </td>
                    <td className="px-5 py-3.5 text-zinc-400 text-xs font-mono">{formatBytes(b.size)}</td>
                    <td className="px-5 py-3.5 text-zinc-400 text-xs">{formatDate(b.mtime)}</td>
                    <td className="px-5 py-3.5">
                      <div className="flex justify-end gap-1.5">
                        {b.local !== false && (
                          <a
                            href={api.backups.downloadUrl(b.name)}
                            download
                            className="px-3 py-1.5 rounded-md text-xs font-medium text-zinc-400 hover:bg-zinc-700 hover:text-zinc-100 transition-colors"
                          >
                            ⬇ Download
                          </a>
                        )}
                        {isAdmin && (
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={() => setRestoreTarget(b)}
                          >
                            ♻️ Restore
                          </Button>
                        )}
                        {isAdmin && (
                          <Button
                            size="sm"
                            variant="danger"
                            disabled={deleting === b.name}
                            aria-label={`Delete ${b.name}`}
                            onClick={() => handleDelete(b)}
                          >
                            {deleting === b.name ? '…' : '🗑️'}
                          </Button>
                        )}
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
