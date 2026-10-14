import React, { useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { useFetch } from '../hooks/useFetch'
import { api } from '../lib/api'
import { Container, RefreshCw } from 'lucide-react'
import { PageHeader, Card, Spinner, ErrorAlert, EmptyState, Button, Icon } from '../components/UI'
import { ServerSelect, EngineBadge } from '../components/servers/ServerBits'

/** Container detail link that carries the server and engine along. */
function containerHref(c, serverId) {
  const params = new URLSearchParams()
  if (serverId !== 'local') params.set('server', serverId)
  if (c.engine && c.engine !== 'postgres') params.set('engine', c.engine)
  const query = params.toString()
  return `/containers/${encodeURIComponent(c.name)}${query ? `?${query}` : ''}`
}

function ContainerCard({ c, serverId }) {
  return (
    <Link to={containerHref(c, serverId)} className="block group">
      <Card className="hover:border-emerald-500/30 hover:bg-zinc-800/50 transition-all cursor-pointer">
        <div className="flex items-center gap-4">
          <div className="flex-1 min-w-0">
            <p className="font-semibold text-zinc-100 group-hover:text-emerald-300 transition-colors truncate">{c.name}</p>
            <p className="text-xs text-zinc-400 font-mono mt-0.5 truncate">{c.image}</p>
          </div>
          <EngineBadge engine={c.engine} />
          <div className="hidden md:block shrink-0 text-right">
            <p className="text-xs text-zinc-400 font-mono">{c.id}</p>
            <p className="text-xs text-zinc-400 mt-0.5">{c.status}</p>
          </div>
        </div>
      </Card>
    </Link>
  )
}

// /containers?server=<id>  (server defaults to the local Docker socket)
export default function Containers() {
  const [params, setParams] = useSearchParams()
  const serverId = params.get('server') || 'local'
  const { data: servers } = useFetch(api.servers.list)
  const { data: containers, loading, error, reload } = useFetch(() => api.containers.list(serverId), [serverId])
  const [search, setSearch] = useState('')

  const server = (servers || []).find((s) => s.id === serverId)
  const hasRemote = (servers || []).some((s) => s.kind === 'docker' && !s.builtin)
  const term = search.toLowerCase()
  const filtered = (containers || []).filter(
    (c) => c.name.toLowerCase().includes(term) || c.image.toLowerCase().includes(term)
  )

  function selectServer(id) {
    setParams(id === 'local' ? {} : { server: id })
  }

  return (
    <div className="p-4 md:p-8">
      <PageHeader
        title="Database Containers"
        subtitle={`Running database containers on ${server?.name || 'the host Docker daemon'}`}
        action={<Button onClick={reload} variant="secondary" size="sm"><Icon as={RefreshCw} /> Refresh</Button>}
      />

      <div className="mb-6 flex flex-wrap items-center gap-3">
        {hasRemote && (
          <ServerSelect
            servers={servers}
            kinds={['docker']}
            value={serverId}
            onChange={selectServer}
            className="bg-zinc-900 border border-zinc-500 rounded-lg px-3 py-2 text-sm text-zinc-100 focus:outline-hidden focus:border-emerald-500 transition-colors"
          />
        )}
        <input
          type="text"
          placeholder="Search by name or image..."
          aria-label="Search containers by name or image"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full max-w-sm bg-zinc-900 border border-zinc-500 rounded-lg px-4 py-2 text-sm text-zinc-100 placeholder-zinc-400 focus:outline-hidden focus:border-emerald-500 transition-colors"
        />
        <Link to="/servers" className="text-xs text-zinc-400 hover:text-zinc-100 transition-colors">Manage servers</Link>
      </div>

      {loading && <div className="flex justify-center py-20"><Spinner /></div>}
      {error && <ErrorAlert message={error} onRetry={reload} />}

      {!loading && !error && filtered.length === 0 && (
        <EmptyState
          icon={Container}
          title="No database containers found"
          description={search ? 'Try a different search term.' : 'No running containers with a supported database image detected. Supported images: PostgreSQL (postgres, postgis, bitnami/postgresql, supabase/postgres, timescaledb), MySQL (mysql, mariadb, percona) and MongoDB (mongo).'}
        />
      )}

      {!loading && !error && (
        <div className="grid gap-3">
          {filtered.map((c) => <ContainerCard key={c.idFull} c={c} serverId={serverId} />)}
        </div>
      )}
    </div>
  )
}
