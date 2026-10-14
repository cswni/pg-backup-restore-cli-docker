import React, { useState } from 'react'
import { useParams, useSearchParams, Link } from 'react-router'
import { useFetch } from '../hooks/useFetch'
import { api } from '../lib/api'
import { useAuth } from '../lib/auth'
import { KeyRound, RefreshCw } from 'lucide-react'
import { PageHeader, Button, BusyIcon, Icon } from '../components/UI'
import DatabaseWorkspace from '../components/ops/DatabaseWorkspace'
import { EngineBadge } from '../components/servers/ServerBits'
import CredentialsDialog, { credentialKeyFor } from '../components/servers/CredentialsDialog'

const EMPTY_HINTS = {
  postgres: "This may not be a PostgreSQL container, or the user 'postgres' has no accessible databases. Admins can set other credentials with the Credentials button.",
  mysql: 'No user databases found. Credentials are read from MYSQL_ROOT_PASSWORD / MARIADB_ROOT_PASSWORD in the container unless an admin saved others.',
  mongodb: 'No user databases found (empty databases do not exist in MongoDB). Credentials are read from MONGO_INITDB_ROOT_USERNAME / _PASSWORD unless an admin saved others.',
}

/** Admin button that opens the credentials dialog for this container. */
function CredentialsButton({ serverId, serverName, containerName, engine, onChanged }) {
  const [dialog, setDialog] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const key = credentialKeyFor(containerName)

  async function openDialog() {
    setLoading(true)
    setError(null)
    try {
      const saved = (await api.containerCredentials.list(serverId)).find((c) => c.key === key) || null
      setDialog({ saved })
    } catch (e) {
      setError(`Could not load saved credentials: ${e.message}`)
    } finally {
      setLoading(false)
    }
  }

  return (
    <>
      <Button variant="secondary" size="sm" className="max-sm:min-h-[44px]" disabled={loading} onClick={openDialog}>
        {loading ? <BusyIcon /> : <Icon as={KeyRound} />} Credentials
      </Button>
      {error && <p role="alert" className="basis-full text-xs text-red-400 break-words">{error}</p>}
      {dialog && (
        <CredentialsDialog
          serverId={serverId}
          serverName={serverName}
          credentialKey={key}
          container={containerName}
          engine={engine}
          saved={dialog.saved}
          onClose={() => setDialog(null)}
          onChanged={onChanged}
        />
      )}
    </>
  )
}

// /containers/:name?server=<id>&engine=<engine>  (server defaults to local)
export default function ContainerDetail() {
  const { name } = useParams()
  const [params] = useSearchParams()
  const { isAdmin } = useAuth()
  const containerName = decodeURIComponent(name)
  const serverId = params.get('server') || 'local'
  const engine = params.get('engine') || 'postgres'

  const { data: server } = useFetch(() => api.servers.get(serverId), [serverId])
  const databases = useFetch(
    () => api.containers.databases(containerName, { serverId, engine }),
    [containerName, serverId, engine],
  )

  const serverName = server?.name || serverId
  const backHref = serverId === 'local' ? '/containers' : `/containers?server=${encodeURIComponent(serverId)}`

  return (
    <div className="p-4 md:p-8">
      <div className="mb-2">
        <Link to={backHref} className="text-xs text-zinc-400 hover:text-zinc-100 transition-colors">← Containers</Link>
      </div>
      <PageHeader
        title={containerName}
        subtitle={
          <span className="inline-flex items-center gap-2">
            <EngineBadge engine={engine} />
            <span>Container on {serverName} · select a database and run an operation</span>
          </span>
        }
        action={
          <div className="flex flex-wrap gap-2">
            {isAdmin && (
              <CredentialsButton serverId={serverId} serverName={serverName} containerName={containerName}
                engine={engine} onChanged={databases.reload} />
            )}
            <Button variant="secondary" size="sm" className="max-sm:min-h-[44px]" onClick={databases.reload}><Icon as={RefreshCw} /> Refresh</Button>
          </div>
        }
      />
      <DatabaseWorkspace
        target={{ serverId, engine, container: containerName }}
        kind="docker"
        targetLabel={`${serverName} / ${containerName}`}
        databases={databases}
        emptyDescription={EMPTY_HINTS[engine] || EMPTY_HINTS.postgres}
      />
    </div>
  )
}
