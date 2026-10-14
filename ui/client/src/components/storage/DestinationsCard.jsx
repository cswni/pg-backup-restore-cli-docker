import React, { useState } from 'react'
import { CircleCheck, CircleX, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { Card, Button, Icon, CHIP_CLASS } from '../UI'
import { api } from '../../lib/api'
import { SectionTitle } from './fields'
import { describeRetention } from './RetentionCard'
import DestinationForm from './DestinationForm'

const TYPE_LABEL = { s3: 'S3', gdrive: 'Google Drive' }

const WARNING_CHIP = 'inline-flex items-center px-2 py-0.5 rounded-md text-[11px] font-medium border bg-amber-500/15 text-amber-300 border-amber-500/25'

/** Neutral label chip; `warning` marks a state that needs action. */
function Pill({ warning = false, children }) {
  return <span className={warning ? WARNING_CHIP : CHIP_CLASS}>{children}</span>
}

function target(d) {
  if (d.type === 's3') return `${d.config.endpoint ? new URL(d.config.endpoint).host + ' · ' : ''}${d.config.bucket}/${d.config.prefix || ''}`
  return d.config.accountEmail || (d.secrets.refreshToken ? 'connected' : 'not connected')
}

function DestinationRow({ d, onEdit, onDelete, onTest, testResult, testing }) {
  const needsConnect = d.type === 'gdrive' && !d.secrets.refreshToken
  return (
    <div className="py-4 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-zinc-100">{d.name}</span>
        <Pill>{TYPE_LABEL[d.type]}</Pill>
        {d.isDefault && <Pill>default</Pill>}
        {!d.enabled && <Pill>disabled</Pill>}
        {needsConnect && <Pill warning>needs connect</Pill>}
        <div className="ml-auto flex flex-wrap gap-1.5">
          {d.type === 'gdrive' && (
            <a
              href={api.storage.gdriveConnectUrl(d.id)}
              className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${needsConnect
                ? 'bg-emerald-500 hover:bg-emerald-400 text-zinc-950'
                : 'bg-zinc-800 hover:bg-zinc-700 text-zinc-200 border border-zinc-700'}`}
            >
              {needsConnect ? 'Connect Google Drive' : <><Icon as={RefreshCw} /> Reconnect</>}
            </a>
          )}
          <Button size="sm" variant="secondary" disabled={testing || needsConnect} onClick={() => onTest(d)}>{testing ? 'Testing…' : 'Test'}</Button>
          <Button size="sm" variant="ghost" onClick={() => onEdit(d)}>Edit</Button>
          <Button size="sm" variant="ghost" aria-label={`Delete destination ${d.name}`} onClick={() => onDelete(d)}><Icon as={Trash2} /></Button>
        </div>
      </div>
      <p className="text-xs text-zinc-400 mt-1.5 font-mono break-all">{target(d)} · {describeRetention(d.retention)}</p>
      {testResult && (
        <p className={`flex items-start gap-1.5 text-xs mt-1.5 ${testResult.ok ? 'text-emerald-400' : 'text-red-400'}`}>
          <Icon as={testResult.ok ? CircleCheck : CircleX} className="size-4 mt-px" />
          <span>{testResult.message}</span>
        </p>
      )}
    </div>
  )
}

export default function DestinationsCard({ destinations, redirectUri, onChanged, notify }) {
  const [form, setForm] = useState(null) // { type, destination? }
  const [testing, setTesting] = useState(null)
  const [results, setResults] = useState({})

  async function save(body) {
    if (form.destination) await api.storage.updateDestination(form.destination.id, body)
    else await api.storage.createDestination(body)
    setForm(null)
    onChanged()
    notify('success', `Saved destination “${body.name}”`)
  }

  async function test(d) {
    setTesting(d.id)
    try {
      const result = await api.storage.testDestination(d.id)
      setResults((r) => ({ ...r, [d.id]: result }))
    } catch (e) {
      setResults((r) => ({ ...r, [d.id]: { ok: false, message: e.message } }))
    } finally {
      setTesting(null)
    }
  }

  async function remove(d) {
    if (!window.confirm(`Delete destination “${d.name}”? Files already uploaded stay where they are but are no longer tracked.`)) return
    try {
      await api.storage.deleteDestination(d.id)
      onChanged()
      notify('success', `Deleted destination “${d.name}”`)
    } catch (e) {
      notify('error', e.message)
    }
  }

  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-3 mb-2">
        <SectionTitle title="Remote destinations" subtitle="Remote copies of each backup are uploaded after compression and encryption." />
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" onClick={() => setForm({ type: 's3' })}><Icon as={Plus} /> S3-compatible</Button>
          <Button size="sm" variant="secondary" onClick={() => setForm({ type: 'gdrive' })}><Icon as={Plus} /> Google Drive</Button>
        </div>
      </div>

      {destinations.length === 0 ? (
        <p className="text-sm text-zinc-400 py-6 text-center">No remote destinations yet. Backups are only stored in /backups.</p>
      ) : (
        <div className="divide-y divide-zinc-800/60">
          {destinations.map((d) => (
            <DestinationRow
              key={d.id} d={d} testing={testing === d.id} testResult={results[d.id]}
              onTest={test} onEdit={(dest) => setForm({ type: dest.type, destination: dest })} onDelete={remove}
            />
          ))}
        </div>
      )}

      {form && (
        <DestinationForm
          key={form.destination?.id || form.type}
          type={form.type}
          destination={form.destination}
          redirectUri={redirectUri}
          onClose={() => setForm(null)}
          onSave={save}
        />
      )}
    </Card>
  )
}
