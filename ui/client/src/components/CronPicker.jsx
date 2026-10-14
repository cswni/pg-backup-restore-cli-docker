import React, { useEffect, useId, useState } from 'react'
import { api } from '../lib/api'
import { PRESETS, WEEKDAYS, buildCron, parseCron } from '../lib/cron'
import { formatInZone } from '../lib/format'

export const inputCls = 'w-full bg-zinc-800 border border-zinc-500 rounded-lg px-3 py-2 text-sm text-zinc-100 placeholder-zinc-400 outline-hidden focus:border-emerald-500 transition-colors'
export const labelCls = 'block text-xs text-zinc-400 mb-1 font-medium uppercase tracking-wider'

const PREVIEW_DEBOUNCE_MS = 300
const pad = (n) => String(n).padStart(2, '0')

/** Debounced server-side preview of the next runs of a cron expression. */
function useCronPreview(cron, timezone) {
  const [state, setState] = useState({ runs: [], error: null, loading: false })
  useEffect(() => {
    if (!cron) {
      setState({ runs: [], error: 'Enter a cron expression', loading: false })
      return undefined
    }
    let cancelled = false
    setState((s) => ({ ...s, loading: true }))
    const t = setTimeout(() => {
      api.schedules.preview(cron, timezone)
        .then((r) => { if (!cancelled) setState({ runs: r.runs, error: null, loading: false }) })
        .catch((e) => { if (!cancelled) setState({ runs: [], error: e.message, loading: false }) })
    }, PREVIEW_DEBOUNCE_MS)
    return () => { cancelled = true; clearTimeout(t) }
  }, [cron, timezone])
  return state
}

function TimeField({ p, update }) {
  const id = useId()
  return (
    <div>
      <label htmlFor={id} className={labelCls}>Time</label>
      <input
        id={id}
        type="time"
        value={`${pad(p.hour)}:${pad(p.minute)}`}
        onChange={(e) => {
          const [h, m] = e.target.value.split(':').map(Number)
          if (Number.isFinite(h) && Number.isFinite(m)) update({ hour: h, minute: m })
        }}
        className={inputCls}
      />
    </div>
  )
}

function PresetFields({ p, update }) {
  const id = useId()
  if (p.preset === 'hourly') {
    return (
      <div>
        <label htmlFor={id} className={labelCls}>Minute past the hour</label>
        <input id={id} type="number" min={0} max={59} value={p.minute}
          onChange={(e) => update({ minute: Math.min(59, Math.max(0, Number(e.target.value) || 0)) })} className={inputCls} />
      </div>
    )
  }
  if (p.preset === 'custom') {
    return (
      <div className="sm:col-span-2">
        <label htmlFor={id} className={labelCls}>Cron expression</label>
        <input id={id} type="text" value={p.custom} placeholder="m h dom mon dow" spellCheck={false}
          onChange={(e) => update({ custom: e.target.value })} className={`${inputCls} font-mono`} />
        <p className="text-xs text-zinc-400 mt-1">5 fields: minute hour day-of-month month day-of-week (e.g. <code>30 1 * * 1-5</code>).</p>
      </div>
    )
  }
  return (
    <>
      {p.preset === 'weekly' && (
        <div>
          <label htmlFor={id} className={labelCls}>Day of week</label>
          <select id={id} value={p.weekday} onChange={(e) => update({ weekday: Number(e.target.value) })} className={inputCls}>
            {WEEKDAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}
          </select>
        </div>
      )}
      {p.preset === 'monthly' && (
        <div>
          <label htmlFor={id} className={labelCls}>Day of month</label>
          <input id={id} type="number" min={1} max={28} value={p.monthDay}
            onChange={(e) => update({ monthDay: Math.min(28, Math.max(1, Number(e.target.value) || 1)) })} className={inputCls} />
        </div>
      )}
      <TimeField p={p} update={update} />
    </>
  )
}

/**
 * Cron editor with presets and a live "next runs" preview.
 * @param {{ cron: string, timezone: string, onChange: (cron: string) => void }} props
 */
export default function CronPicker({ cron, timezone, onChange }) {
  const [p, setP] = useState(() => parseCron(cron))
  const preview = useCronPreview(cron, timezone)

  const update = (patch) => {
    const next = { ...p, ...patch }
    const expr = buildCron(next)
    setP({ ...next, custom: next.preset === 'custom' ? next.custom : expr })
    onChange(expr)
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Frequency">
        {PRESETS.map(({ id, label }) => (
          <button key={id} type="button" role="radio" aria-checked={p.preset === id} onClick={() => update({ preset: id })}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
              p.preset === id ? 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30' : 'text-zinc-400 border-zinc-700 hover:text-zinc-100 hover:bg-zinc-800'
            }`}>
            {label}
          </button>
        ))}
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <PresetFields p={p} update={update} />
      </div>
      <div className="rounded-lg border border-zinc-800 bg-zinc-950/60 px-3 py-2.5">
        <p className="text-xs text-zinc-400 mb-1.5">
          Next runs <span className="font-mono text-zinc-400">({cron || 'no expression'} · {timezone})</span>
        </p>
        {preview.error ? (
          <p className="text-xs text-red-400">{preview.error}</p>
        ) : (
          <ol className={`text-xs font-mono text-zinc-300 space-y-0.5 ${preview.loading ? 'opacity-50' : ''}`}>
            {preview.runs.map((r) => <li key={r}>{formatInZone(r, timezone)}</li>)}
          </ol>
        )}
      </div>
    </div>
  )
}
