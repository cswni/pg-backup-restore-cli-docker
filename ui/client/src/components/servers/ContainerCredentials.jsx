import React, { useState, useCallback, useEffect, useId } from 'react'
import { ChevronDown, KeyRound } from 'lucide-react'
import { api } from '../../lib/api'
import { Button, ErrorAlert, Spinner, Icon, CHIP_CLASS } from '../UI'
import { engineLabel } from './ServerBits'
import CredentialsDialog from './CredentialsDialog'

// "Container credentials" section of a Docker server card (admins only).
// Loaded on demand: listing containers runs `docker ps` on the server.

const ROW = 'flex flex-wrap items-center gap-x-3 gap-y-1 py-2 border-t border-zinc-800 first:border-t-0'

/** Rows for running containers plus saved keys whose container is not running. */
function buildRows(containers, saved) {
  const byKey = new Map(saved.map((c) => [c.key, c]))
  const running = containers.map((c) => {
    const record = byKey.get(c.credentialKey)
    const matches = record?.engine === c.engine
    return {
      id: c.idFull, name: c.name, key: c.credentialKey, engine: c.engine, container: c.name,
      saved: matches ? record : null, savedOther: record && !matches ? record : null,
    }
  })
  const runningKeys = new Set(containers.map((c) => c.credentialKey))
  const idle = saved.filter((c) => !runningKeys.has(c.key))
    .map((c) => ({ id: `saved:${c.key}`, name: c.key, key: c.key, engine: c.engine, container: null, saved: c, savedOther: null }))
  return [...running, ...idle]
}

function sourceText(row) {
  if (!row.container) return 'Saved credentials, container not running'
  if (row.saved) return 'Saved credentials'
  if (row.savedOther) return `From container environment (saved ones are for ${engineLabel(row.savedOther.engine)})`
  return 'From container environment'
}

function CredentialRows({ rows, onEdit }) {
  if (rows.length === 0) {
    return <p className="text-sm text-zinc-400 py-2">No running database containers on this server and no saved credentials.</p>
  }
  return (
    <ul>
      {rows.map((row) => (
        <li key={row.id} className={ROW}>
          <div className="flex-1 min-w-48">
            <p className="font-mono text-sm text-zinc-100 break-all">{row.name}</p>
            <p className={`text-xs mt-0.5 ${row.saved ? 'text-zinc-300' : 'text-zinc-400'}`}>{sourceText(row)}</p>
          </div>
          <span className={CHIP_CLASS}>{engineLabel(row.engine)}</span>
          <Button size="sm" variant="secondary" className="max-sm:min-h-[44px]" onClick={() => onEdit(row)}
            aria-label={`${row.saved ? 'Edit' : 'Set'} credentials for ${row.name}`}>
            {row.saved ? 'Edit' : 'Set'}
          </Button>
        </li>
      ))}
    </ul>
  )
}

/** @param {{ server: object }} props  a Docker server (public view) */
export default function ContainerCredentials({ server }) {
  const [open, setOpen] = useState(false)
  const [state, setState] = useState({ loading: false, containers: null, containersError: null, saved: null, savedError: null })
  const [editing, setEditing] = useState(null)
  const panelId = useId()

  const load = useCallback(async () => {
    setState((s) => ({ ...s, loading: true }))
    const [containers, saved] = await Promise.allSettled([api.containers.list(server.id), api.containerCredentials.list(server.id)])
    setState({
      loading: false,
      containers: containers.status === 'fulfilled' ? containers.value : null,
      containersError: containers.status === 'rejected' ? containers.reason.message : null,
      saved: saved.status === 'fulfilled' ? saved.value : null,
      savedError: saved.status === 'rejected' ? saved.reason.message : null,
    })
  }, [server.id])

  useEffect(() => { if (open) load() }, [open, load])

  const rows = state.saved ? buildRows(state.containers || [], state.saved) : []
  const savedCount = state.saved?.length

  return (
    <div className="mt-4 border-t border-zinc-800 pt-3">
      <button type="button" aria-expanded={open} aria-controls={panelId} onClick={() => setOpen((v) => !v)}
        className="w-full min-h-[44px] -my-2 flex items-center gap-2 text-left text-sm font-medium text-zinc-300 hover:text-zinc-100 transition-colors">
        <Icon as={KeyRound} className="size-4 text-zinc-400" />
        <span className="flex-1">Container credentials</span>
        {open && savedCount !== undefined && <span className="text-xs text-zinc-400">{savedCount} saved</span>}
        <Icon as={ChevronDown} className={`size-4 text-zinc-400 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div id={panelId} className="mt-3 space-y-3">
          <p className="text-xs text-zinc-400">
            Without saved credentials the container's own environment is used (MYSQL_ROOT_PASSWORD, MONGO_INITDB_ROOT_*, the postgres OS user).
            Swarm task containers share the credentials of their service.
          </p>
          {state.loading && !state.saved && <div className="flex justify-center py-4"><Spinner size="sm" label="Loading containers…" /></div>}
          {state.savedError && <ErrorAlert message={`Could not load saved credentials: ${state.savedError}`} onRetry={load} />}
          {state.containersError && (
            <ErrorAlert message={`Could not list containers: ${state.containersError}. Saved credentials are still listed below.`} onRetry={load} />
          )}
          {state.saved && <CredentialRows rows={rows} onEdit={setEditing} />}
        </div>
      )}

      {editing && (
        <CredentialsDialog
          serverId={server.id}
          serverName={server.name}
          credentialKey={editing.key}
          container={editing.container}
          engine={editing.engine}
          saved={editing.saved || editing.savedOther}
          onClose={() => setEditing(null)}
          onChanged={load}
        />
      )}
    </div>
  )
}
