import React from 'react'
import { useParams, useSearchParams, Link } from 'react-router'
import { useFetch } from '../hooks/useFetch'
import { api } from '../lib/api'
import { PageHeader, Button } from '../components/UI'
import DatabaseWorkspace from '../components/ops/DatabaseWorkspace'
import { EngineBadge } from '../components/servers/ServerBits'

const EMPTY_HINTS = {
  postgres: "This may not be a PostgreSQL container, or the user 'postgres' has no accessible databases.",
  mysql: 'No user databases found. Credentials are read from MYSQL_ROOT_PASSWORD / MARIADB_ROOT_PASSWORD in the container.',
  mongodb: 'No user databases found (empty databases do not exist in MongoDB). Credentials are read from MONGO_INITDB_ROOT_USERNAME / _PASSWORD.',
}

// /containers/:name?server=<id>&engine=<engine>  (server defaults to local)
export default function ContainerDetail() {
  const { name } = useParams()
  const [params] = useSearchParams()
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
        action={<Button variant="secondary" size="sm" onClick={databases.reload}>↻ Refresh</Button>}
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
