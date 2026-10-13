import React, { useState, useEffect } from 'react'
import { useFetch } from '../../hooks/useFetch'
import { api } from '../../lib/api'
import { Spinner, DbNameInput, Toggle, DB_NAME_PATTERN, dropTargetHint } from '../UI'
import { isCompatibleBackup } from '../../lib/engines'
import { ServerSelect, engineLabel } from './ServerBits'

// Where a backup is restored: server → container (Docker servers only) →
// target database. Shared by the Backups page restore dialogs.

const SELECT_CLASS = 'w-full bg-zinc-800 border border-zinc-700 focus:border-emerald-500 rounded-lg px-3 py-2 text-sm font-mono text-zinc-100 outline-hidden transition-colors'
const LABEL_CLASS = 'block text-xs text-zinc-500 mb-1 font-medium uppercase tracking-wider'

/** Fetch a list when `fetcher` is set; [] otherwise. Ignores stale responses. */
function useList(fetcher, key) {
  const [state, setState] = useState({ items: [], loading: false })
  useEffect(() => {
    if (!fetcher) { setState({ items: [], loading: false }); return }
    let cancelled = false
    setState({ items: [], loading: true })
    fetcher()
      .then((items) => { if (!cancelled) setState({ items, loading: false }) })
      .catch(() => { if (!cancelled) setState({ items: [], loading: false }) })
    return () => { cancelled = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  return state
}

/**
 * Restore target state.
 * @param {string} initialDb  suggested target database name
 * @param {{ name?: string, engine?: string|null }} [backup]  the backup to restore: only
 *   containers / direct servers of a matching engine are offered (see lib/engines)
 * @returns {object} state, setters, `ready` and the /api/ops `payload`
 */
export function useRestoreTarget(initialDb = '', backup = null) {
  const [serverId, setServerId] = useState('local')
  const [container, setContainer] = useState('')
  const [db, setDb] = useState(initialDb)
  const [dropExisting, setDropExisting] = useState(false)
  const { data: allServers, loading: loadingServers } = useFetch(api.servers.list)

  const matches = (engine) => !backup?.name || isCompatibleBackup(backup.name, backup.engine, engine)
  const servers = allServers && allServers.filter((s) => s.kind === 'docker' || matches(s.engine))
  const server = (servers || []).find((s) => s.id === serverId) || null
  const isDocker = !server || server.kind === 'docker'
  const allContainers = useList(isDocker ? () => api.containers.list(serverId) : null, `${serverId}:${isDocker}`)
  const containers = { ...allContainers, items: allContainers.items.filter((c) => matches(c.engine)) }
  const engine = isDocker
    ? containers.items.find((c) => c.name === container)?.engine || 'postgres'
    : server.engine
  const databases = useList(
    isDocker
      ? container && (() => api.containers.databases(container, { serverId, engine }))
      : () => api.servers.databases(serverId),
    `${serverId}:${container}:${engine}`,
  )

  function selectServer(id) {
    setServerId(id)
    setContainer('')
  }

  return {
    servers, loadingServers, server, serverId, selectServer, isDocker,
    containers, container, setContainer, databases,
    db, setDb, dropExisting, setDropExisting,
    ready: (!isDocker || !!container) && DB_NAME_PATTERN.test(db),
    payload: { serverId, engine, container: isDocker ? container : undefined, database: db, dropExisting },
  }
}

function ContainerField({ target }) {
  if (target.containers.loading) return <Spinner size="sm" />
  return (
    <>
      <select value={target.container} onChange={(e) => target.setContainer(e.target.value)} className={SELECT_CLASS}>
        <option value="">— select container —</option>
        {target.containers.items.map((c) => <option key={c.idFull} value={c.name}>{c.name} ({engineLabel(c.engine)})</option>)}
      </select>
      {target.containers.items.length === 0 && (
        <p className="text-xs text-zinc-500 mt-1">No running container with a matching database engine on this server.</p>
      )}
    </>
  )
}

/** Server, container and target database fields for a useRestoreTarget() state. */
export default function RestoreTargetFields({ id, target }) {
  const { databases, db, isDocker, container } = target
  const exists = databases.items.includes(db)
  const hasSource = !isDocker || !!container
  return (
    <>
      {(target.servers || []).length > 1 && (
        <div>
          <label className={LABEL_CLASS}>Target Server</label>
          <ServerSelect servers={target.servers} value={target.serverId} onChange={target.selectServer} />
        </div>
      )}
      {isDocker && (
        <div>
          <label className={LABEL_CLASS}>Target Container</label>
          <ContainerField target={target} />
        </div>
      )}
      <div>
        <label className={LABEL_CLASS}>
          Target Database
          {databases.loading && <span className="ml-2 text-zinc-600 normal-case tracking-normal">loading…</span>}
        </label>
        <DbNameInput
          id={id}
          value={db}
          onChange={target.setDb}
          options={databases.items}
          placeholder={hasSource ? 'existing or new database name' : 'Select a container first'}
        />
        {hasSource && db && !databases.loading && (
          <p className="text-xs text-zinc-500 mt-1">
            {exists ? 'Database exists on this server.' : 'Database will be created.'}
          </p>
        )}
      </div>
      <Toggle
        danger
        checked={target.dropExisting}
        onChange={target.setDropExisting}
        label="Drop target database before restore"
        hint={dropTargetHint(db, exists, target.dropExisting)}
      />
    </>
  )
}
