import React, { useState } from 'react'
import { Link } from 'react-router'
import { api } from '../../lib/api'
import { CircleCheck, Trash2, TriangleAlert } from 'lucide-react'
import { Card, Button, BusyIcon, Icon } from '../UI'
import { KindBadge, endpointText, serverHref } from './ServerBits'

function TestResult({ result }) {
  if (!result) return null
  if (result.ok) {
    return (
      <p className="flex items-start gap-1.5 text-xs text-emerald-400 mt-3 break-words">
        <Icon as={CircleCheck} className="size-4 mt-px" />
        <span>
          Connected in {result.latencyMs} ms
          {result.version && <span className="text-emerald-400/70"> · {result.version}</span>}
          {result.details && <span className="text-emerald-400/70"> · {result.details}</span>}
        </span>
      </p>
    )
  }
  return (
    <p className="flex items-start gap-1.5 text-xs text-red-400 mt-3 break-words">
      <Icon as={TriangleAlert} className="size-4 mt-px" />
      <span>{result.error} <span className="text-red-400/60">({result.latencyMs} ms)</span></span>
    </p>
  )
}

function HostKeys({ server, isAdmin, onForget }) {
  const keys = server.hostKeys || []
  if (server.builtin || (server.kind === 'direct' && !server.tunnel)) return null
  return (
    <div className="mt-3 text-xs text-zinc-400">
      {keys.length === 0 && <span>Host key: not trusted yet. It is recorded on the first connection.</span>}
      {keys.map((k) => (
        <div key={k.fingerprint} className="font-mono break-all">
          Host key {k.type} <span className="text-zinc-300">{k.fingerprint}</span>
        </div>
      ))}
      {keys.length > 0 && isAdmin && (
        <button type="button" onClick={onForget} className="min-h-[44px] -mb-2 text-amber-400/80 hover:text-amber-300 underline">
          Forget host key
        </button>
      )}
    </div>
  )
}

/**
 * One server in the Servers list.
 * @param {{ server: object, isAdmin: boolean, onEdit: Function, onDelete: Function, onChanged: Function }} props
 */
export default function ServerCard({ server, isAdmin, onEdit, onDelete, onChanged }) {
  const [testing, setTesting] = useState(false)
  const [result, setResult] = useState(null)

  async function runTest() {
    setTesting(true)
    setResult(null)
    try {
      setResult(await api.servers.test(server.id))
      onChanged() // a first SSH connection records the host key
    } catch (e) {
      setResult({ ok: false, error: e.message, latencyMs: 0 })
    } finally {
      setTesting(false)
    }
  }

  async function forgetHostKey() {
    if (!window.confirm(`Forget the trusted host key of ${server.name}? The next connection will trust whatever key the host presents.`)) return
    try {
      await api.servers.forgetHostKey(server.id)
      onChanged()
    } catch (e) {
      setResult({ ok: false, error: e.message, latencyMs: 0 })
    }
  }

  return (
    <Card>
      <div className="flex flex-wrap items-start gap-4">
        <div className="flex-1 min-w-48">
          <div className="flex flex-wrap items-center gap-2">
            <Link to={serverHref(server)} className="font-semibold text-zinc-100 hover:text-emerald-300 transition-colors">
              {server.name}
            </Link>
            <KindBadge server={server} />
          </div>
          <p className="text-xs text-zinc-400 font-mono mt-1 break-all">{endpointText(server)}</p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <Link to={serverHref(server)}
            className="px-3 py-1.5 rounded-md text-xs font-medium text-zinc-400 hover:bg-zinc-700 hover:text-zinc-100 transition-colors">
            {server.kind === 'direct' ? 'Databases' : 'Containers'}
          </Link>
          {isAdmin && (
            <Button size="sm" variant="secondary" disabled={testing} onClick={runTest}>
              {testing ? <><BusyIcon /> Testing…</> : 'Test'}
            </Button>
          )}
          {isAdmin && !server.builtin && <Button size="sm" variant="secondary" onClick={() => onEdit(server)}>Edit</Button>}
          {isAdmin && !server.builtin && <Button size="sm" variant="danger" aria-label={`Delete server ${server.name}`} onClick={() => onDelete(server)}><Icon as={Trash2} /></Button>}
        </div>
      </div>
      <HostKeys server={server} isAdmin={isAdmin} onForget={forgetHostKey} />
      <TestResult result={result} />
    </Card>
  )
}
