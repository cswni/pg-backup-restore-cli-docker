import React, { useId, useRef, useState } from 'react'
import { Play } from 'lucide-react'
import { api } from '../../lib/api'
import { Button, BusyIcon, ErrorAlert, Icon } from '../UI'
import { formatCount } from '../../lib/format'
import DataGrid, { FOCUS_RING } from './DataGrid'

const ROW_LIMIT = 500
const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)
const SHORTCUT = IS_MAC ? 'Cmd+Enter' : 'Ctrl+Enter'

function ResultSummary({ result }) {
  const count = `${formatCount(result.rows.length)} ${result.rows.length === 1 ? 'row' : 'rows'}`
  return (
    <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 mb-3 text-xs text-zinc-400" role="status">
      <span>{count}</span>
      <span>{formatCount(result.durationMs)} ms</span>
      {result.truncated && (
        <span className="text-zinc-200">
          Truncated at {formatCount(result.rows.length)} rows. Add a WHERE clause or LIMIT to see the rest.
        </span>
      )}
    </div>
  )
}

/**
 * Read-only SQL console (admins, PostgreSQL and MySQL). `sql` is owned by the
 * parent so the text survives tab and table switches.
 * @param {{ base: object, sql: string, onSqlChange: (sql: string) => void }} props
 */
export default function QueryTab({ base, sql, onSqlChange }) {
  const inputId = useId()
  const hintId = useId()
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)
  const runId = useRef(0)

  async function run() {
    if (!sql.trim() || running) return
    const ticket = ++runId.current
    setRunning(true)
    setError(null)
    try {
      const data = await api.explorer.query({ ...base, sql, limit: ROW_LIMIT })
      if (ticket === runId.current) setResult(data)
    } catch (e) {
      if (ticket === runId.current) {
        setResult(null)
        setError(e.message || 'The query failed')
      }
    } finally {
      if (ticket === runId.current) setRunning(false)
    }
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      run()
    }
  }

  return (
    <div>
      <label htmlFor={inputId} className="block text-xs font-medium text-zinc-300 mb-1.5">SQL</label>
      <textarea
        id={inputId}
        value={sql}
        onChange={(e) => onSqlChange(e.target.value)}
        onKeyDown={handleKeyDown}
        rows={6}
        spellCheck={false}
        aria-describedby={hintId}
        placeholder="SELECT * FROM orders LIMIT 20"
        className="w-full bg-zinc-950 border border-zinc-500 focus:border-emerald-500 focus-visible:outline-2 focus-visible:outline-emerald-400 rounded-lg px-3 py-2 text-sm font-mono text-zinc-100 placeholder-zinc-400 resize-y"
      />
      <div className="flex flex-wrap items-center justify-between gap-3 mt-2 mb-4">
        <p id={hintId} className="text-xs text-zinc-400 max-w-prose">
          {base.engine === 'postgres' ? 'One query per run (SELECT, WITH, VALUES or TABLE)' : 'One statement per run'},
          with a semicolon only at the end. It runs read only, stops after 10 seconds and returns at most {ROW_LIMIT} rows.
          {' '}{SHORTCUT} runs it.
        </p>
        <Button onClick={run} disabled={running || !sql.trim()} className={`min-h-[44px] ${FOCUS_RING}`}>
          {running ? <BusyIcon /> : <Icon as={Play} />} {running ? 'Running…' : 'Run'}
        </Button>
      </div>

      {error && <ErrorAlert message={<span className="whitespace-pre-wrap font-mono text-xs">{error}</span>} />}
      {result && !error && (
        <>
          <ResultSummary result={result} />
          {result.columns.length > 0
            ? <DataGrid caption="Query result" columns={result.columns} rows={result.rows} />
            : <p className="text-sm text-zinc-400">The statement returned no columns.</p>}
        </>
      )}
    </div>
  )
}
