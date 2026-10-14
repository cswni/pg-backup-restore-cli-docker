import React, { useId, useState } from 'react'
import { Eye, Table2, FileJson } from 'lucide-react'
import { ErrorAlert } from '../UI'
import { formatBytes, formatCount } from '../../lib/format'
import Loading from './Loading'
import { SELECT_CLASS } from './TargetPicker'

const TYPE_ICONS = { table: Table2, view: Eye, collection: FileJson }

export function objectKey(o) {
  return `${o.schema ?? ''}.${o.name}`
}

/** "about 12,480 rows · 3.1 MB"; parts the server did not report are left out. */
function objectHint(o) {
  const parts = []
  if (o.type === 'view') parts.push('view')
  if (o.rows != null) parts.push(`about ${formatCount(o.rows)} ${o.type === 'collection' ? 'documents' : 'rows'}`)
  if (o.sizeBytes != null) parts.push(formatBytes(o.sizeBytes))
  return parts.join(' · ')
}

/** Objects grouped by schema, in server order. MySQL and MongoDB have one group (schema null). */
function groupBySchema(objects) {
  const groups = new Map()
  for (const o of objects) {
    const key = o.schema ?? ''
    groups.set(key, [...(groups.get(key) || []), o])
  }
  return [...groups.entries()]
}

function ObjectButton({ object, isSelected, onSelect }) {
  const Glyph = TYPE_ICONS[object.type] || Table2
  const hint = objectHint(object)
  return (
    <li>
      <button
        type="button"
        onClick={() => onSelect(object)}
        aria-current={isSelected ? 'true' : undefined}
        className={`w-full min-h-[44px] flex items-start gap-2 px-2.5 py-2 rounded-lg text-left transition-colors focus-visible:outline-2 focus-visible:outline-emerald-400 ${
          isSelected ? 'bg-emerald-500/15 text-emerald-300' : 'text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100'
        }`}
      >
        <Glyph aria-hidden="true" className="size-4 mt-0.5 shrink-0 text-zinc-400" />
        <span className="min-w-0">
          <span className="block font-mono text-xs break-all">{object.name}</span>
          {hint && <span className="block text-[11px] text-zinc-400 mt-0.5">{hint}</span>}
        </span>
      </button>
    </li>
  )
}

function DesktopTree({ groups, selectedKey, onSelect }) {
  return (
    <div className="hidden md:block max-h-[65dvh] overflow-y-auto -mx-1 px-1">
      {groups.map(([schema, items]) => (
        <section key={schema || 'default'} className="mb-3 last:mb-0">
          {schema && <h3 className="px-2.5 py-1 text-xs font-medium text-zinc-400">{schema}</h3>}
          <ul className="space-y-0.5">
            {items.map((o) => (
              <ObjectButton key={objectKey(o)} object={o} isSelected={objectKey(o) === selectedKey} onSelect={onSelect} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}

function MobileSelect({ groups, selectedKey, onSelect, noun }) {
  const id = useId()
  const byKey = new Map(groups.flatMap(([, items]) => items.map((o) => [objectKey(o), o])))
  return (
    <div className="md:hidden">
      <label htmlFor={id} className="block text-xs font-medium text-zinc-300 mb-1.5">Open {noun}</label>
      <select id={id} value={byKey.has(selectedKey) ? selectedKey : ''} className={SELECT_CLASS}
        onChange={(e) => onSelect(byKey.get(e.target.value))}>
        <option value="" disabled>Choose a {noun}</option>
        {groups.map(([schema, items]) => {
          const options = items.map((o) => (
            <option key={objectKey(o)} value={objectKey(o)}>{o.name}{o.type === 'view' ? ' (view)' : ''}</option>
          ))
          return schema ? <optgroup key={schema} label={schema}>{options}</optgroup> : options
        })}
      </select>
    </div>
  )
}

/**
 * Tables and views (PostgreSQL, MySQL) or collections (MongoDB) of the chosen
 * database, with a name filter. A list on desktop, a select on phones.
 * @param {{ request: { data: { objects: object[] }|null, loading: boolean, error: string|null, reload: Function },
 *   engine: string, selectedKey: string, onSelect: (object: object) => void }} props
 */
export default function ObjectList({ request, engine, selectedKey, onSelect }) {
  const searchId = useId()
  const [search, setSearch] = useState('')
  const isMongo = engine === 'mongodb'
  const noun = isMongo ? 'collection' : 'table'
  const title = isMongo ? 'Collections' : 'Tables and views'

  if (request.loading && !request.data) return <Loading>Loading {isMongo ? 'collections' : 'tables'}…</Loading>
  if (request.error) return <ErrorAlert message={request.error} onRetry={request.reload} />

  const objects = request.data?.objects || []
  if (objects.length === 0) {
    return (
      <p className="py-6 text-sm text-zinc-400">
        No {isMongo ? 'collections' : 'tables or views'} in this database.
        {isMongo ? ' MongoDB creates a collection on its first insert.' : ' Create one, or restore a backup into it, then refresh.'}
      </p>
    )
  }

  const term = search.trim().toLowerCase()
  const filtered = term ? objects.filter((o) => `${o.schema ?? ''}.${o.name}`.toLowerCase().includes(term)) : objects
  const groups = groupBySchema(filtered)

  return (
    <div>
      <div className="flex items-baseline justify-between gap-2 mb-3">
        <h2 className="font-semibold text-zinc-200">{title}</h2>
        <span className="text-xs text-zinc-400">{formatCount(objects.length)}</span>
      </div>
      <label htmlFor={searchId} className="sr-only">Filter {isMongo ? 'collections' : 'tables'} by name</label>
      <input
        id={searchId}
        type="search"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Filter by name"
        className="w-full min-h-[44px] mb-3 bg-zinc-800 border border-zinc-500 rounded-lg px-3 py-2 text-sm text-zinc-100 placeholder-zinc-400 focus:border-emerald-500 focus-visible:outline-2 focus-visible:outline-emerald-400 transition-colors"
      />
      {filtered.length === 0
        ? <p className="py-4 text-sm text-zinc-400">Nothing matches "{search.trim()}".</p>
        : (
          <>
            <DesktopTree groups={groups} selectedKey={selectedKey} onSelect={onSelect} />
            <MobileSelect groups={groups} selectedKey={selectedKey} onSelect={onSelect} noun={noun} />
          </>
        )}
    </div>
  )
}
