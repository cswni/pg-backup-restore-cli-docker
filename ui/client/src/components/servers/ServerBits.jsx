import React from 'react'

// Small shared pieces for server-aware pages.

const KIND_STYLES = {
  local:  { label: 'Local Docker', cls: 'bg-zinc-700/30 text-zinc-300 border-zinc-600' },
  docker: { label: 'Docker · SSH', cls: 'bg-sky-500/15 text-sky-300 border-sky-500/20' },
  direct: { label: 'Direct', cls: 'bg-violet-500/15 text-violet-300 border-violet-500/20' },
}

const ENGINE_LABELS = { postgres: 'PostgreSQL', mysql: 'MySQL', mariadb: 'MariaDB', mongodb: 'MongoDB' }

export function engineLabel(engine) {
  return ENGINE_LABELS[engine] || engine
}

const ENGINE_STYLES = {
  postgres: 'bg-blue-500/15 text-blue-300 border-blue-500/25',
  mysql: 'bg-orange-500/15 text-orange-300 border-orange-500/25',
  mongodb: 'bg-green-500/15 text-green-300 border-green-500/25',
}

/** Badge naming a database engine ("PostgreSQL", "MySQL", "MongoDB"). */
export function EngineBadge({ engine }) {
  if (!engine) return null
  const cls = ENGINE_STYLES[engine] || 'bg-zinc-700/30 text-zinc-300 border-zinc-600'
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium border ${cls}`}>
      {engineLabel(engine)}
    </span>
  )
}

/** Badge for a server's kind ("Local Docker", "Docker · SSH", "Direct · PostgreSQL"). */
export function KindBadge({ server }) {
  const style = server.builtin ? KIND_STYLES.local : KIND_STYLES[server.kind]
  const label = server.kind === 'direct' ? `${style.label} · ${engineLabel(server.engine)}` : style.label
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium border ${style.cls}`}>
      {label}
    </span>
  )
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
