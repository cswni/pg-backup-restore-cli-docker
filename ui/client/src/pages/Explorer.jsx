import React from 'react'
import { RefreshCw } from 'lucide-react'
import { api } from '../lib/api'
import { useAuth } from '../lib/auth'
import { useFetch } from '../hooks/useFetch'
import { useRequest } from '../hooks/useRequest'
import { PageHeader, Card, Button, ErrorAlert, Icon } from '../components/UI'
import TargetPicker from '../components/explorer/TargetPicker'
import ObjectList, { objectKey } from '../components/explorer/ObjectList'
import Workspace from '../components/explorer/Workspace'
import Loading from '../components/explorer/Loading'
import { useExplorerTarget } from '../components/explorer/useExplorerTarget'

/** Server, container list and database list for the current selection. */
function useTargetLists(target, server) {
  const isDocker = server?.kind === 'docker'
  const containers = useRequest(isDocker ? () => api.containers.list(target.serverId) : null, [target.serverId, isDocker])
  const entry = (containers.data || []).find((c) => c.name === target.container)
  const engine = server?.kind === 'direct' ? server.engine : (target.engine || entry?.engine || '')

  let fetchDatabases = null
  if (server?.kind === 'direct') fetchDatabases = () => api.servers.databases(server.id)
  else if (isDocker && target.container && engine) {
    fetchDatabases = () => api.containers.databases(target.container, { serverId: target.serverId, engine })
  }
  const databases = useRequest(fetchDatabases, [server?.id, server?.kind, target.container, engine])
  return { containers, databases, engine, isDocker }
}

// /explorer?server=&container=&engine=&database=&schema=&object=&tab=
export default function Explorer() {
  const { isAdmin } = useAuth()
  const { target, select } = useExplorerTarget()
  const servers = useFetch(api.servers.list)
  const server = (servers.data || []).find((s) => s.id === target.serverId)
  const { containers, databases, engine, isDocker } = useTargetLists(target, server)

  const base = target.database && engine && (!isDocker || target.container)
    ? { serverId: target.serverId, engine, container: isDocker ? target.container : undefined, database: target.database }
    : null
  const objects = useRequest(base ? () => api.explorer.objects(base) : null, [JSON.stringify(base)])

  const objectList = objects.data?.objects || []
  const selectedKey = target.object ? `${target.schema}.${target.object}` : ''
  const selected = objectList.find((o) => objectKey(o) === selectedKey) || null
  const missingObject = objects.data && target.object && !selected ? target.object : null
  let listState = 'ready'
  if (objects.error) listState = 'error'
  else if (!objects.data) listState = 'loading'
  else if (objectList.length === 0) listState = 'empty'

  function refresh() {
    containers.reload()
    databases.reload()
    objects.reload()
  }

  return (
    <div className="p-4 md:p-8">
      <PageHeader
        title="Explorer"
        subtitle="Browse the tables, views and collections of a database. Admins can edit or delete rows of tables with a primary key, and documents of collections."
        action={<Button variant="secondary" size="sm" onClick={refresh} className="min-h-[44px]"><Icon as={RefreshCw} /> Refresh</Button>}
      />

      <Card className="mb-6">
        {servers.loading && <Loading>Loading servers…</Loading>}
        {servers.error && <ErrorAlert message={servers.error} onRetry={servers.reload} />}
        {servers.data && (
          <>
            <TargetPicker servers={servers.data} server={server} target={target}
              containers={containers} databases={databases} onSelect={select} />
            {!server && (
              <p role="alert" className="mt-3 text-sm text-red-400">
                No server with the id "{target.serverId}". Pick another server.
              </p>
            )}
          </>
        )}
      </Card>

      {base && (
        <div className="grid gap-6 md:grid-cols-[minmax(14rem,18rem)_minmax(0,1fr)] items-start">
          <Card className="min-w-0">
            <ObjectList request={objects} engine={engine} selectedKey={selected ? objectKey(selected) : ''}
              onSelect={(o) => select({ schema: o.schema ?? '', object: o.name })} />
          </Card>
          <Card className="min-w-0">
            <Workspace key={JSON.stringify(base)} base={base} engine={engine} object={selected}
              tab={target.tab} onTab={(tab) => select({ tab })} isAdmin={isAdmin} missingObject={missingObject} listState={listState} />
          </Card>
        </div>
      )}
    </div>
  )
}
