import React, { useEffect, useId, useState } from 'react'
import { api } from '../lib/api'
import { Spinner } from './UI'

/**
 * Checkbox list of remote destinations for a schedule. No selection means the
 * destinations marked as default on the Storage page. IDs that no longer exist
 * stay listed so saving the form never drops them silently.
 * @param {{ value: string[], onChange: (ids: string[]) => void }} props
 */
export default function DestinationPicker({ value, onChange }) {
  const id = useId()
  const [state, setState] = useState({ items: [], loading: true, error: null })

  useEffect(() => {
    let cancelled = false
    api.storage.defaults()
      .then((d) => { if (!cancelled) setState({ items: d.destinations || [], loading: false, error: null }) })
      .catch((e) => { if (!cancelled) setState({ items: [], loading: false, error: e.message }) })
    return () => { cancelled = true }
  }, [])

  const known = new Set(state.items.map((d) => d.id))
  const unknown = value.filter((v) => !known.has(v))
  const toggle = (destId, checked) => onChange(checked ? [...value, destId] : value.filter((v) => v !== destId))

  return (
    <fieldset aria-describedby={`${id}-hint`}>
      <legend className="text-sm text-zinc-300">Remote destinations</legend>
      <p id={`${id}-hint`} className="text-xs text-zinc-400 mt-0.5 mb-2">
        None selected: the default remote destinations from the Storage page.
      </p>
      {state.loading && <Spinner size="sm" label="Loading remote destinations…" />}
      {state.error && <p role="alert" className="text-xs text-red-400">Could not load remote destinations: {state.error}</p>}
      {!state.loading && !state.error && state.items.length === 0 && unknown.length === 0 && (
        <p className="text-xs text-zinc-400">No remote destinations configured.</p>
      )}
      <div className="space-y-1">
        {state.items.map((d) => (
          <label key={d.id} className="flex items-center gap-2 min-h-[44px] text-sm text-zinc-200">
            <input type="checkbox" className="size-4 accent-emerald-500" checked={value.includes(d.id)} onChange={(e) => toggle(d.id, e.target.checked)} />
            <span>{d.name}</span>
            <span className="text-xs text-zinc-400">
              {d.type === 'gdrive' ? 'Google Drive' : 'S3'}{d.isDefault ? ', default' : ''}{d.ready ? '' : ', not connected'}
            </span>
          </label>
        ))}
        {unknown.map((destId) => (
          <label key={destId} className="flex items-center gap-2 min-h-[44px] text-sm text-amber-300">
            <input type="checkbox" className="size-4 accent-emerald-500" checked onChange={() => toggle(destId, false)} />
            <span>Deleted destination <span className="font-mono">{destId}</span> (uncheck to remove)</span>
          </label>
        ))}
      </div>
    </fieldset>
  )
}
