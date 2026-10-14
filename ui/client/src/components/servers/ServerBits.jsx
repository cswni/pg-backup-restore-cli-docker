import React from 'react'
import { CHIP_CLASS } from '../UI'

const KIND_LABELS = { local: 'Local Docker', docker: 'Docker · SSH', direct: 'Direct' }

const ENGINE_LABELS = { postgres: 'PostgreSQL', mysql: 'MySQL', mariadb: 'MariaDB', mongodb: 'MongoDB' }

export function engineLabel(engine) {
  return ENGINE_LABELS[engine] || engine
}

/** Badge naming a database engine ("PostgreSQL", "MySQL", "MongoDB"). */
export function EngineBadge({ engine }) {
  if (!engine) return null
  return <span className={CHIP_CLASS}>{engineLabel(engine)}</span>
}

/** Badge for a server's kind ("Local Docker", "Docker · SSH", "Direct · PostgreSQL"). */
export function KindBadge({ server }) {
  const kind = KIND_LABELS[server.builtin ? 'local' : server.kind]
  const label = server.kind === 'direct' ? `${kind} · ${engineLabel(server.engine)}` : kind
  return <span className={CHIP_CLASS}>{label}</span>
}

/** One-line description of where a server lives. */
export function endpointText(server) {
  if (server.builtin) return 'Docker socket of this host'
  if (server.kind === 'docker') return `ssh://${server.ssh.user}@${server.ssh.host}:${server.ssh.port}`
  const db = `${server.username}@${server.host}:${server.port}/${server.database}`
  return server.tunnel ? `${db} via ${server.tunnel.user}@${server.tunnel.host}:${server.tunnel.port}` : db
}

/** Link to where a server's databases are managed. */
export function serverHref(server) {
  if (server.kind === 'direct') return `/servers/${encodeURIComponent(server.id)}/databases`
  return server.builtin ? '/containers' : `/containers?server=${encodeURIComponent(server.id)}`
}

const SELECT_CLASS = 'w-full bg-zinc-800 border border-zinc-500 focus:border-emerald-500 rounded-lg px-3 py-2 text-sm text-zinc-100 outline-hidden transition-colors'

/**
 * Server dropdown.
 * @param {{ id?: string, servers: object[], value: string, onChange: (id: string) => void, kinds?: string[], className?: string }} props
 */
export function ServerSelect({ id, servers, value, onChange, kinds, className = SELECT_CLASS }) {
  const options = (servers || []).filter((s) => !kinds || kinds.includes(s.kind))
  return (
    <select id={id} value={value} onChange={(e) => onChange(e.target.value)} className={className}
      aria-label={id ? undefined : 'Server'}>
      {options.map((s) => (
        <option key={s.id} value={s.id}>
          {s.name}{s.kind === 'direct' ? ` (${engineLabel(s.engine)})` : s.builtin ? '' : ' (Docker · SSH)'}
        </option>
      ))}
    </select>
  )
}
