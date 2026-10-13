import React from 'react'
import { useParams, useSearchParams, Link } from 'react-router'
import { useFetch } from '../hooks/useFetch'
import { api } from '../lib/api'
import { PageHeader, Button } from '../components/UI'
import DatabaseWorkspace from '../components/ops/DatabaseWorkspace'

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
    <div className="p-8">
      <div className="mb-2">
        <Link to={backHref} className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors">← Containers</Link>
      </div>
      <PageHeader
        title={containerName}
        subtitle={`Container on ${serverName} · select a database and run an operation`}
        action={<Button variant="secondary" size="sm" onClick={databases.reload}>↻ Refresh</Button>}
      />
      <DatabaseWorkspace
        target={{ serverId, engine, container: containerName }}
        targetLabel={`${serverName} / ${containerName}`}
        databases={databases}
        emptyDescription="This may not be a PostgreSQL container, or the user 'postgres' has no accessible databases."
      />
    </div>
  )
}
