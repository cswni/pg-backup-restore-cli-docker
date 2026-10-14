import React, { useEffect, useState } from 'react'
import { api } from '../../lib/api'
import { Toggle, Spinner } from '../UI'

/** File suffix produced by the chosen options, e.g. '.sql.gz.enc'. */
export function exportSuffix(options, baseExt = '.sql') {
  return `${baseExt}${options?.compress ? '.gz' : ''}${options?.encrypt ? '.enc' : ''}`
}

/**
 * Compression / encryption / destination choices for an export, initialised
 * from the storage defaults. Calls `onChange(options)` with the `options`
 * object sent to POST /api/ops/export (or null while loading / on error,
 * which lets the server apply its defaults).
 */
export default function ExportStorageOptions({ onChange }) {
  const [defaults, setDefaults] = useState(null)
  const [error, setError] = useState(null)
  const [options, setOptions] = useState(null)

  useEffect(() => {
    let cancelled = false
    api.storage.defaults()
      .then((d) => {
        if (cancelled) return
        setDefaults(d)
        setOptions({
          compress: d.compress,
          encrypt: d.encrypt && d.encryptionAvailable,
          destinations: d.destinations.filter((x) => x.isDefault && x.ready).map((x) => x.id),
        })
      })
      .catch((e) => { if (!cancelled) setError(e.message) })
    return () => { cancelled = true }
  }, [])

  useEffect(() => { onChange(options) }, [options, onChange])

  if (error) return <p role="alert" className="text-xs text-zinc-400">Storage defaults unavailable ({error}). Server defaults apply.</p>
  if (!defaults || !options) return <Spinner size="sm" />

  const update = (patch) => setOptions((o) => ({ ...o, ...patch }))
  const toggleDest = (id) => update({
    destinations: options.destinations.includes(id)
      ? options.destinations.filter((x) => x !== id)
      : [...options.destinations, id],
  })

  return (
    <div className="space-y-3 rounded-xl border border-zinc-800 bg-zinc-950/40 p-4">
      <Toggle checked={options.compress} onChange={(compress) => update({ compress })} label="Compress (gzip)" />
      <Toggle
        checked={options.encrypt}
        onChange={(encrypt) => update({ encrypt: encrypt && defaults.encryptionAvailable })}
        label="Encrypt (AES-256-GCM)"
        hint={defaults.encryptionAvailable ? 'Restoring needs the configured passphrase.' : 'Set a passphrase in Storage settings first.'}
      />
      {defaults.destinations.length > 0 && (
        <fieldset>
          <legend className="text-xs text-zinc-400 mb-2 font-medium uppercase tracking-wider">Upload to</legend>
          <div className="space-y-1.5">
            {defaults.destinations.map((d) => (
              <label key={d.id} className={`flex items-center gap-2 text-sm text-zinc-300 ${d.ready ? 'cursor-pointer' : 'opacity-50'}`}>
                <input
                  type="checkbox"
                  className="accent-emerald-500"
                  disabled={!d.ready}
                  checked={options.destinations.includes(d.id)}
                  onChange={() => toggleDest(d.id)}
                />
                <span>{d.type === 's3' ? '🪣' : '📁'} {d.name}</span>
                {d.isDefault && <span className="text-[10px] text-zinc-400">default</span>}
                {!d.ready && <span className="text-[10px] text-amber-400">not connected</span>}
              </label>
            ))}
          </div>
        </fieldset>
      )}
    </div>
  )
}
