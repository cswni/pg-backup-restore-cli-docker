import React, { useEffect, useRef, useState } from 'react'
import { useParams, Link, useNavigate } from 'react-router'
import { api } from '../lib/api'
import { Check, CircleCheck, CircleX } from 'lucide-react'
import { StatusBadge, Button, Spinner, Icon } from '../components/UI'
import { formatDateTime, operationLabel } from '../lib/format'
import { copyText } from '../lib/clipboard'

const COPY_FEEDBACK_MS = 2000

/** "server / container / database · by user · started …" */
function describeJob(job) {
  const m = job.meta || {}
  const parts = [[m.serverName, job.container, job.database].filter(Boolean).join(' / ')]
  if (m.scheduleName) parts.push(`schedule ${m.scheduleName}`)
  if (job.username) parts.push(`by ${job.username}`)
  if (job.startedAt) parts.push(formatDateTime(job.startedAt))
  return parts.filter(Boolean).join(' · ')
}

export default function JobLog() {
  const { jobId } = useParams()
  const navigate = useNavigate()
  const [lines, setLines] = useState([])
  const [status, setStatus] = useState('running')
  const [meta, setMeta] = useState(null)
  const [exitCode, setExitCode] = useState(null)
  // 'live' while the stream is open; 'lost' when it dropped before the job finished
  const [connection, setConnection] = useState('live')
  const [copyState, setCopyState] = useState(null) // null | 'copied' | 'failed'
  const bottomRef = useRef(null)
  const logRef = useRef(null)
  const [autoScroll, setAutoScroll] = useState(true)

  useEffect(() => {
    api.jobs.get(jobId)
      .then((j) => setMeta(j))
      .catch(() => {})
  }, [jobId])

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

    // A dropped stream says nothing about the job itself: ask the API for its real state
    es.onerror = () => {
      es.close()
      api.jobs.get(jobId)
        .then((job) => {
          if (job.status === 'running') {
            setConnection('lost')
            return
          }
          setStatus(job.status)
          setExitCode(job.exitCode ?? null)
        })
        .catch(() => setConnection('lost'))
    }

    return () => es.close()
  }, [jobId])

  useEffect(() => {
    if (autoScroll && bottomRef.current) {
      bottomRef.current.scrollIntoView({ behavior: 'smooth' })
    }
  }, [lines, autoScroll])

  async function copyLog() {
    const ok = await copyText(lines.map((l) => l.text).join('\n'))
    setCopyState(ok ? 'copied' : 'failed')
    if (ok) {
      setTimeout(() => setCopyState(null), COPY_FEEDBACK_MS)
      return
    }
    // Select the log so it can be copied by hand
    const range = document.createRange()
    range.selectNodeContents(logRef.current)
    window.getSelection().removeAllRanges()
    window.getSelection().addRange(range)
  }

  const lineClass = (type) => {
    if (type === 'stderr') return 'text-amber-400'
    if (type === 'done')   return exitCode === 0 ? 'text-emerald-400' : 'text-red-400'
    return 'text-zinc-300'
  }

  return (
    <div className="flex flex-col h-full">
      <div className="shrink-0 px-4 md:px-8 py-4 md:py-5 border-b border-zinc-800 flex flex-wrap items-center gap-3 md:gap-4">
        <button type="button" onClick={() => navigate(-1)} className="text-zinc-400 hover:text-zinc-100 transition-colors text-sm">← Back</button>
        <div className="h-4 w-px bg-zinc-800" />
        <div className="flex-1 min-w-48">
          <div className="flex items-center gap-3">
            <p className="font-mono text-emerald-400 text-sm font-semibold">{meta ? operationLabel(meta.operation) : '…'}</p>
            <StatusBadge status={status} />
          </div>
          <p className="text-xs text-zinc-400 font-mono mt-0.5 truncate">
            {meta ? describeJob(meta) : jobId}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-xs text-zinc-400 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={autoScroll}
              onChange={(e) => setAutoScroll(e.target.checked)}
              className="accent-emerald-500"
            />
            Auto-scroll
          </label>
          {status === 'running' && connection === 'live' && <Spinner size="sm" label="Job running" />}
          {exitCode !== null && (
            <span className={`text-xs font-mono px-2 py-1 rounded-md border ${
              exitCode === 0
                ? 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20'
                : 'text-red-400 bg-red-500/10 border-red-500/20'
            }`}>
              exit {exitCode}
            </span>
          )}
          <Button size="sm" variant="secondary" disabled={lines.length === 0} onClick={copyLog}>
            {copyState === 'copied' ? <><Icon as={Check} /> Copied</> : 'Copy log'}
          </Button>
        </div>
        {copyState === 'failed' && (
          <p role="alert" className="basis-full text-xs text-red-400">
            Copy failed. The log is selected, so copy it with Ctrl+C (Cmd+C on a Mac).
          </p>
        )}
      </div>

      <div
        className="flex-1 overflow-y-auto bg-zinc-950 font-mono text-xs leading-relaxed p-4 md:p-6"
        style={{ minHeight: 0 }}
      >
        {lines.length === 0 && status === 'running' && connection === 'live' && (
          <div className="flex items-center gap-2 text-zinc-400">
            <span aria-hidden="true" className="w-2 h-2 rounded-full bg-blue-400 pulse-dot" /> Waiting for output…
          </div>
        )}
        {lines.length === 0 && status !== 'running' && (
          <p className="text-zinc-400">
            No log output is stored for this job (logs are kept for a limited number of days).
          </p>
        )}
        <div ref={logRef}>
        {lines.map((line, i) => (
          <div key={i} className={`whitespace-pre-wrap break-all ${lineClass(line.type)}`}>
            <span className="text-zinc-400 select-none mr-3 text-[10px]">
              {new Date(line.ts).toLocaleTimeString()}
            </span>
            {line.text}
          </div>
        ))}
        </div>
        <div ref={bottomRef} />
      </div>

      {status === 'running' && connection === 'lost' && (
        <div role="alert" className="shrink-0 px-4 md:px-8 py-3 border-t border-amber-500/25 bg-amber-500/10 text-amber-300 text-xs font-medium flex flex-wrap items-center gap-3">
          <span>Connection to the live log was lost. The job may still be running.</span>
          <button type="button" onClick={() => window.location.reload()} className="ml-auto min-h-[44px] px-2 underline hover:text-amber-200">
            Reload
          </button>
        </div>
      )}

      {status !== 'running' && (
        <div role="status" className={`shrink-0 px-4 md:px-8 py-3 border-t text-xs font-medium flex items-center gap-3 ${
          exitCode === 0
            ? 'border-emerald-500/20 bg-emerald-500/5 text-emerald-400'
            : 'border-red-500/20 bg-red-500/5 text-red-400'
        }`}>
          <Icon as={exitCode === 0 ? CircleCheck : CircleX} />
          <span>{exitCode === 0 ? 'Operation completed successfully' : 'Operation failed'}</span>
          <Link to="/" className="ml-auto text-zinc-400 hover:text-zinc-100 transition-colors">
            Dashboard
          </Link>
        </div>
      )}
    </div>
  )
}

