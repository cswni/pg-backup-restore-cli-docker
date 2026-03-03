import React, { useEffect, useRef, useState } from 'react'
import { useParams, Link, useNavigate } from 'react-router-dom'
import { api } from '../lib/api'
import { StatusBadge, Button, Spinner } from '../components/UI'

export default function JobLog() {
  const { jobId } = useParams()
  const navigate = useNavigate()
  const [lines, setLines] = useState([])
  const [status, setStatus] = useState('running')
  const [meta, setMeta] = useState(null)
  const [exitCode, setExitCode] = useState(null)
  const bottomRef = useRef(null)
  const [autoScroll, setAutoScroll] = useState(true)

  // Load initial job meta
  useEffect(() => {
    api.jobs.get(jobId)
      .then((j) => setMeta(j))
      .catch(() => {})
  }, [jobId])

  // SSE stream
  useEffect(() => {
    const es = new EventSource(api.jobs.streamUrl(jobId))

    es.addEventListener('log', (e) => {
      const line = JSON.parse(e.data)
      setLines((prev) => [...prev, line])
    })

    es.addEventListener('done', (e) => {
      const { exitCode: code } = JSON.parse(e.data)
      setExitCode(code)
      setStatus(code === 0 ? 'success' : 'error')
      es.close()
    })

    es.onerror = () => {
      setStatus((s) => s === 'running' ? 'error' : s)
      es.close()
    }

    return () => es.close()
  }, [jobId])

  // Auto-scroll
  useEffect(() => {
    if (autoScroll && bottomRef.current) {
      bottomRef.current.scrollIntoView({ behavior: 'smooth' })
    }
  }, [lines, autoScroll])

  const lineClass = (type) => {
    if (type === 'stderr') return 'text-amber-400'
    if (type === 'done')   return exitCode === 0 ? 'text-emerald-400' : 'text-red-400'
    return 'text-zinc-300'
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex-shrink-0 px-8 py-5 border-b border-zinc-800 flex items-center gap-4">
        <button onClick={() => navigate(-1)} className="text-zinc-500 hover:text-zinc-300 transition-colors text-sm">← Back</button>
        <div className="h-4 w-px bg-zinc-800" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-3">
            <p className="font-mono text-emerald-400 text-sm font-semibold">{meta?.operation ?? '…'}</p>
            <StatusBadge status={status} />
          </div>
          <p className="text-xs text-zinc-500 font-mono mt-0.5 truncate">
            {meta ? `${meta.container} → ${meta.database}` : jobId}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-xs text-zinc-500 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={autoScroll}
              onChange={(e) => setAutoScroll(e.target.checked)}
              className="accent-emerald-500"
            />
            Auto-scroll
          </label>
          {status === 'running' && <Spinner size="sm" />}
          {exitCode !== null && (
            <span className={`text-xs font-mono px-2 py-1 rounded-md border ${
              exitCode === 0
                ? 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20'
                : 'text-red-400 bg-red-500/10 border-red-500/20'
            }`}>
              exit {exitCode}
            </span>
          )}
          <Button size="sm" variant="secondary" onClick={() => {
            const text = lines.map((l) => l.text).join('\n')
            navigator.clipboard.writeText(text)
          }}>
            Copy Log
          </Button>
        </div>
      </div>

      {/* Log output */}
      <div
        className="flex-1 overflow-y-auto bg-zinc-950 font-mono text-xs leading-relaxed p-6"
        style={{ minHeight: 0 }}
      >
        {lines.length === 0 && status === 'running' && (
          <div className="flex items-center gap-2 text-zinc-600">
            <span className="pulse-dot">●</span> Waiting for output…
          </div>
        )}
        {lines.map((line, i) => (
          <div key={i} className={`whitespace-pre-wrap break-all ${lineClass(line.type)}`}>
            <span className="text-zinc-700 select-none mr-3 text-[10px]">
              {new Date(line.ts).toLocaleTimeString()}
            </span>
            {line.text}
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      {/* Footer */}
      {status !== 'running' && (
        <div className={`flex-shrink-0 px-8 py-3 border-t text-xs font-medium flex items-center gap-3 ${
          exitCode === 0
            ? 'border-emerald-500/20 bg-emerald-500/5 text-emerald-400'
            : 'border-red-500/20 bg-red-500/5 text-red-400'
        }`}>
          <span>{exitCode === 0 ? '✅ Operation completed successfully' : '❌ Operation failed'}</span>
          <Link to="/" className="ml-auto text-zinc-500 hover:text-zinc-300 transition-colors">
            Dashboard →
          </Link>
        </div>
      )}
    </div>
  )
}

