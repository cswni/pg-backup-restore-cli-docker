import React, { useId, useState } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { api } from '../../lib/api'
import { useRequest } from '../../hooks/useRequest'
import { Button, ErrorAlert, Icon } from '../UI'
import { formatCount } from '../../lib/format'
import DataGrid, { FOCUS_RING } from './DataGrid'
import Loading from './Loading'
import { SELECT_CLASS } from './TargetPicker'

const PAGE_SIZES = [25, 50, 100, 200]
const DEFAULT_PAGE_SIZE = 50
const FILTER_EXAMPLE = '{ "status": "active" }'

/** Parse a MongoDB filter; returns { error } when it is not a JSON object. */
function checkFilter(text) {
  const trimmed = text.trim()
  if (!trimmed) return { value: '' }
  let parsed
  try {
    parsed = JSON.parse(trimmed)
  } catch (e) {
    return { error: `The filter is not valid JSON: ${e.message}` }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { error: `The filter must be a JSON object, for example ${FILTER_EXAMPLE}.` }
  }
  return { value: trimmed }
}

function MongoFilter({ applied, onApply }) {
  const id = useId()
  const errorId = useId()
  const [text, setText] = useState(applied)
  const [error, setError] = useState(null)

  function handleSubmit(e) {
    e.preventDefault()
    const result = checkFilter(text)
    setError(result.error || null)
    if (!result.error) onApply(result.value)
  }

  function handleClear() {
    setText('')
    setError(null)
    onApply('')
  }

  return (
    <form onSubmit={handleSubmit} className="mb-4">
      <label htmlFor={id} className="block text-xs font-medium text-zinc-300 mb-1.5">Filter documents (JSON)</label>
      <div className="flex flex-wrap gap-2">
        <input
          id={id}
          type="text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={FILTER_EXAMPLE}
          spellCheck={false}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          className={`flex-1 min-w-[12rem] min-h-[44px] bg-zinc-800 border rounded-lg px-3 py-2 text-sm font-mono text-zinc-100 placeholder-zinc-400 focus-visible:outline-2 focus-visible:outline-emerald-400 transition-colors ${
            error ? 'border-red-500/70' : 'border-zinc-500 focus:border-emerald-500'
          }`}
        />
        <Button type="submit" variant="secondary" className={`min-h-[44px] ${FOCUS_RING}`}>Apply</Button>
        <Button type="button" variant="ghost" onClick={handleClear} disabled={!text && !applied} className={`min-h-[44px] ${FOCUS_RING}`}>Clear</Button>
      </div>
      {error && <p id={errorId} role="alert" className="mt-1.5 text-xs text-red-400 break-words">{error}</p>}
    </form>
  )
}

function rangeText(data) {
  if (!data.rows.length) return 'No rows on this page'
  const first = data.offset + 1
  const last = data.offset + data.rows.length
  const total = data.total != null ? ` of ${formatCount(data.total)}` : ''
  return `Showing rows ${formatCount(first)} to ${formatCount(last)}${total}`
}

function Pager({ data, pageSize, busy, onPageSize, onOffset }) {
  const sizeId = useId()
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 mt-3">
      <p className="text-xs text-zinc-400" aria-live="polite">{rangeText(data)}</p>
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={sizeId} className="text-xs text-zinc-400">Rows per page</label>
        <select id={sizeId} value={pageSize} onChange={(e) => onPageSize(Number(e.target.value))}
          className={SELECT_CLASS.replace('w-full ', 'w-auto ')}>
          {PAGE_SIZES.map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
        <Button variant="secondary" disabled={busy || data.offset === 0} className={`min-h-[44px] ${FOCUS_RING}`}
          onClick={() => onOffset(Math.max(0, data.offset - pageSize))}>
          <Icon as={ChevronLeft} /> Previous
        </Button>
        <Button variant="secondary" disabled={busy || !data.hasMore} className={`min-h-[44px] ${FOCUS_RING}`}
          onClick={() => onOffset(data.offset + data.rows.length)}>
          Next <Icon as={ChevronRight} />
        </Button>
      </div>
    </div>
  )
}

/**
 * Rows of one table, view or collection, a page at a time.
 * @param {{ base: object, object: { schema: string|null, name: string, type: string }, engine: string }} props
 */
export default function DataTab({ base, object, engine }) {
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE)
  const [offset, setOffset] = useState(0)
  const [sort, setSort] = useState(null)
  const [filter, setFilter] = useState('')
  const isMongo = engine === 'mongodb'

  const params = {
    ...base,
    schema: object.schema ?? undefined,
    name: object.name,
    limit: pageSize,
    offset,
    sort: sort?.column,
    dir: sort?.dir,
    filter: isMongo ? filter : undefined,
  }
  const rows = useRequest(() => api.explorer.rows(params), [JSON.stringify(params)])

  const restart = (apply) => (value) => { apply(value); setOffset(0) }
  const data = rows.data
  const label = `${object.schema ? `${object.schema}.` : ''}${object.name}`
  const caption = `Rows of ${label}${sort ? `, sorted by ${sort.column} ${sort.dir === 'asc' ? 'ascending' : 'descending'}` : ''}`

  return (
    <div>
      {isMongo && <MongoFilter applied={filter} onApply={restart(setFilter)} />}
      {rows.error && <ErrorAlert message={rows.error} onRetry={rows.reload} />}
      {!rows.error && !data && <Loading>Loading rows…</Loading>}
      {!rows.error && data && data.rows.length === 0 && data.offset === 0 && (
        <p className="py-6 text-sm text-zinc-400">
          {filter ? 'No documents match this filter. Change it or select Clear.' : `${label} is empty.`}
        </p>
      )}
      {!rows.error && data && (data.rows.length > 0 || data.offset > 0) && (
        <>
          {rows.loading && <Loading className="pb-2">Loading the page…</Loading>}
          <div className={rows.loading ? 'opacity-60' : undefined}>
            <DataGrid caption={caption} columns={data.columns} rows={data.rows} rowOffset={data.offset}
              sort={sort} onSort={restart(setSort)} />
          </div>
          <Pager data={data} pageSize={pageSize} busy={rows.loading} onPageSize={restart(setPageSize)} onOffset={setOffset} />
        </>
      )}
    </div>
  )
}
