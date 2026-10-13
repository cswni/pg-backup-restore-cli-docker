import React, { useState, useRef, useEffect } from 'react'
import { useFetch } from '../hooks/useFetch'
import { api } from '../lib/api'
import { PageHeader, Spinner, ErrorAlert, Button } from '../components/UI'
import ServerCard from '../components/servers/ServerCard'
import ServerForm from '../components/servers/ServerForm'

/**
 * Servers: the local Docker socket, remote Docker hosts over SSH and direct
 * database connections. Everyone can see them; only admins can add, edit,
 * delete or test (the API enforces it too).
 *
 * `isAdmin` defaults to true until the auth module passes the real role in
 * (same convention as Layout).
 */
export default function Servers({ isAdmin = true }) {
  const { data: servers, loading, error, reload } = useFetch(api.servers.list)
  const [editing, setEditing] = useState(null) // null | 'new' | server
  const [toast, setToast] = useState(null)
  const toastTimer = useRef(null)

  useEffect(() => () => clearTimeout(toastTimer.current), [])

  function showToast(type, msg) {
    clearTimeout(toastTimer.current)
    setToast({ type, msg })
    toastTimer.current = setTimeout(() => setToast(null), 4000)
  }

  async function save(payload) {
    if (editing === 'new') await api.servers.create(payload)
    else await api.servers.update(editing.id, payload)
    setEditing(null)
    showToast('success', `Saved ${payload.name}`)
    reload()
  }

  async function remove(server) {
    if (!window.confirm(`Delete ${server.name}? Backups made from it are kept.`)) return
    try {
      await api.servers.remove(server.id)
      showToast('success', `Deleted ${server.name}`)
      reload()
    } catch (e) {
      showToast('error', e.message)
    }
  }

  return (
    <div className="p-8">
      <PageHeader
        title="Servers"
        subtitle="Docker hosts and database servers this UI can back up and restore"
        action={
          <div className="flex gap-2">
            {isAdmin && <Button size="sm" className="whitespace-nowrap" onClick={() => setEditing('new')}>＋ Add server</Button>}
            <Button size="sm" variant="secondary" className="whitespace-nowrap" onClick={reload}>↻ Refresh</Button>
          </div>
        }
      />

      {toast && (
        <div className={`mb-6 flex items-center gap-2 px-4 py-3 rounded-xl text-sm border ${
          toast.type === 'error' ? 'bg-red-500/10 border-red-500/20 text-red-400' : 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400'
        }`}>
          <span>{toast.type === 'error' ? '⚠️' : '✅'}</span>
          {toast.msg}
        </div>
      )}

      {loading && !servers && <div className="flex justify-center py-20"><Spinner /></div>}
      {error && <ErrorAlert message={error} onRetry={reload} />}

      {servers && (
        <div className="grid gap-3">
          {servers.map((s) => (
            <ServerCard key={s.id} server={s} isAdmin={isAdmin} onEdit={setEditing} onDelete={remove} onChanged={reload} />
          ))}
        </div>
      )}

      {editing && (
        <ServerForm
          server={editing === 'new' ? undefined : editing}
          onClose={() => setEditing(null)}
          onSave={save}
        />
      )}
    </div>
  )
}
