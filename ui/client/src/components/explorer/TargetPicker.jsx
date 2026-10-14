import React, { useId } from 'react'
import { ServerSelect, engineLabel } from '../servers/ServerBits'
import Loading from './Loading'

export const SELECT_CLASS = 'w-full min-h-[44px] bg-zinc-800 border border-zinc-500 focus:border-emerald-500 focus-visible:outline-2 focus-visible:outline-emerald-400 rounded-lg px-3 py-2 text-sm text-zinc-100 transition-colors'

function Field({ id, label, children }) {
  return (
    <div className="min-w-0">
      <label htmlFor={id} className="block text-xs font-medium text-zinc-300 mb-1.5">{label}</label>
      {children}
    </div>
  )
}

/** Inline status under a picker: loading text, the server's error, or an empty hint. */
function PickerStatus({ request, emptyText, isEmpty, onRetry }) {
  if (request.loading && !request.data) return <Loading className="mt-2">Loading…</Loading>
  if (request.error) {
    return (
      <p role="alert" className="mt-2 text-xs text-red-400 break-words">
        {request.error}{' '}
        <button type="button" onClick={onRetry} className="min-h-[44px] underline hover:text-red-300">Retry</button>
      </p>
    )
  }
  if (isEmpty) return <p className="mt-2 text-xs text-zinc-400">{emptyText}</p>
  return null
}

function ContainerField({ containers, value, onChange }) {
  const id = useId()
  const list = containers.data || []
  const isListed = list.some((c) => c.name === value)
  return (
    <Field id={id} label="Container">
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)} className={SELECT_CLASS}
        disabled={!list.length && !value}>
        <option value="" disabled>Choose a container</option>
        {value && !isListed && <option value={value}>{value}</option>}
        {list.map((c) => (
          <option key={c.idFull} value={c.name}>{c.name} ({engineLabel(c.engine)})</option>
        ))}
      </select>
      <PickerStatus request={containers} isEmpty={!containers.loading && !containers.error && list.length === 0}
        emptyText="No running database containers on this server." onRetry={containers.reload} />
    </Field>
  )
}

function DatabaseField({ databases, value, onChange, waitingFor }) {
  const id = useId()
  const list = databases.data || []
  // Keep a deep-linked database selectable while the list loads or if it is not listed
  const options = value && !list.includes(value) ? [value, ...list] : list
  return (
    <Field id={id} label="Database">
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)} className={SELECT_CLASS}
        disabled={!options.length}>
        <option value="" disabled>{waitingFor ? `Choose a ${waitingFor} first` : 'Choose a database'}</option>
        {options.map((db) => <option key={db} value={db}>{db}</option>)}
      </select>
      {!waitingFor && (
        <PickerStatus request={databases} isEmpty={!databases.loading && !databases.error && list.length === 0}
          emptyText="The server lists no databases this user can read." onRetry={databases.reload} />
      )}
    </Field>
  )
}

/**
 * Server, then container (Docker servers), then database.
 * @param {{ servers: object[], server: object|undefined, target: object, containers: object, databases: object,
 *   onSelect: (changes: object) => void }} props
 */
export default function TargetPicker({ servers, server, target, containers, databases, onSelect }) {
  const serverId = useId()
  const isDocker = server?.kind === 'docker'
  return (
    <div className={`grid gap-4 ${isDocker ? 'sm:grid-cols-3' : 'sm:grid-cols-2'}`}>
      <Field id={serverId} label="Server">
        <ServerSelect id={serverId} servers={servers} value={target.serverId} className={SELECT_CLASS}
          onChange={(id) => onSelect({ server: id })} />
      </Field>
      {isDocker && (
        <ContainerField containers={containers} value={target.container}
          onChange={(name) => {
            const entry = (containers.data || []).find((c) => c.name === name)
            onSelect({ container: name, engine: entry?.engine || '' })
          }} />
      )}
      <DatabaseField databases={databases} value={target.database}
        waitingFor={isDocker && !target.container ? 'container' : null}
        onChange={(database) => onSelect({ database })} />
    </div>
  )
}
