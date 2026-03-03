import React, { useState } from 'react'
import { Link } from 'react-router-dom'
import { useFetch } from '../hooks/useFetch'
import { api } from '../lib/api'
import { PageHeader, Card, Spinner, ErrorAlert, EmptyState, Button } from '../components/UI'

export default function Containers() {
  const { data: containers, loading, error, reload } = useFetch(api.containers.list)
  const [search, setSearch] = useState('')

  const filtered = (containers || []).filter(
    (c) =>
      c.name.toLowerCase().includes(search.toLowerCase()) ||
      c.image.toLowerCase().includes(search.toLowerCase())
  )

  return (
    <div className="p-8">
      <PageHeader
        title="PostgreSQL Containers"
        subtitle="Running containers with a PostgreSQL image on the host Docker daemon"
        action={<Button onClick={reload} variant="secondary" size="sm">↻ Refresh</Button>}
      />

      {/* Search */}
      <div className="mb-6">
        <input
          type="text"
          placeholder="Search by name or image..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full max-w-sm bg-zinc-900 border border-zinc-700 rounded-lg px-4 py-2 text-sm text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-emerald-500 transition-colors"
        />
      </div>

      {loading && <div className="flex justify-center py-20"><Spinner /></div>}
      {error && <ErrorAlert message={error} onRetry={reload} />}

      {!loading && !error && filtered.length === 0 && (
        <EmptyState
          icon="🐘"
          title="No PostgreSQL containers found"
          description={search ? 'Try a different search term.' : 'No running containers with a PostgreSQL image detected. Supported images: postgres, postgis, bitnami/postgresql, supabase/postgres, timescaledb.'}
        />
      )}

      {!loading && !error && (
        <div className="grid gap-3">
          {filtered.map((c) => (
            <Link
              key={c.idFull}
              to={`/containers/${encodeURIComponent(c.name)}`}
              className="block group"
            >
              <Card className="hover:border-emerald-500/30 hover:bg-zinc-800/50 transition-all cursor-pointer">
                <div className="flex items-center gap-4">
                  {/* Status dot */}
                  <div className="flex-shrink-0 w-2.5 h-2.5 rounded-full bg-emerald-400 shadow-md shadow-emerald-500/30" />

                  {/* Name & image */}
                  <div className="flex-1 min-w-0">
                    <p className="font-semibold text-zinc-100 group-hover:text-emerald-300 transition-colors truncate">
                      {c.name}
                    </p>
                    <p className="text-xs text-zinc-500 font-mono mt-0.5 truncate">{c.image}</p>
                  </div>

                  {/* ID */}
                  <div className="hidden md:block flex-shrink-0 text-right">
                    <p className="text-xs text-zinc-600 font-mono">{c.id}</p>
                    <p className="text-xs text-zinc-600 mt-0.5">{c.status}</p>
                  </div>

                  {/* Arrow */}
                  <span className="text-zinc-600 group-hover:text-emerald-400 transition-colors text-lg">→</span>
                </div>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}

