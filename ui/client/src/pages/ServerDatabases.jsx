import React from 'react'
import { useParams, Link } from 'react-router'
import { useFetch } from '../hooks/useFetch'
import { api } from '../lib/api'
import { PageHeader, Button, Spinner, ErrorAlert } from '../components/UI'
import DatabaseWorkspace from '../components/ops/DatabaseWorkspace'
import { KindBadge, endpointText } from '../components/servers/ServerBits'

// /servers/:id/databases: databases of a direct (TCP / SSH tunnel) server
export default function ServerDatabases() {
  const { id } = useParams()
  const { data: server, loading, error, reload } = useFetch(() => api.servers.get(id), [id])
  const databases = useFetch(() => api.servers.databases(id), [id])

  return (
    <div className="p-4 md:p-8">
      <div className="mb-2">
        <Link to="/servers" className="text-xs text-zinc-400 hover:text-zinc-100 transition-colors">← Servers</Link>
      </div>

      {loading && <div className="flex justify-center py-20"><Spinner /></div>}
      {error && <ErrorAlert message={error} onRetry={reload} />}

      {server && server.kind !== 'direct' && (
        <ErrorAlert message={`${server.name} is a Docker server. Open it from the Containers page.`} />
      )}

      {server?.kind === 'direct' && (
        <>
          <PageHeader
            title={server.name}
            subtitle={<span className="inline-flex items-center gap-2"><KindBadge server={server} /><span className="font-mono">{endpointText(server)}</span></span>}
            action={<Button variant="secondary" size="sm" onClick={databases.reload}>↻ Refresh</Button>}
          />
          <DatabaseWorkspace
            target={{ serverId: server.id, engine: server.engine }}
            kind="direct"
            targetLabel={`${server.name} (${server.host}:${server.port})`}
            databases={databases}
            emptyDescription="The configured user cannot see any databases on this server."
          />
        </>
      )}
    </div>
  )
}
