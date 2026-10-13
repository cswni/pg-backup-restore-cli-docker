import React, { useState } from 'react'
import { useFetch } from '../hooks/useFetch'
import { api } from '../lib/api'
import { PageHeader, Card, Spinner, ErrorAlert, EmptyState, Button, Toggle } from '../components/UI'
import { inputCls, labelCls } from '../components/CronPicker'

const FORMAT_LABELS = { generic: 'Generic JSON', slack: 'Slack', discord: 'Discord', teams: 'Microsoft Teams' }
const EVENT_LABELS = {
  'job.failed': 'Job failed',
  'job.succeeded': 'Job succeeded',
  'schedule.overdue': 'Schedule missed / overdue',
}

function WebhookForm({ webhook, formats, events, onSaved, onCancel }) {
  const [form, setForm] = useState({
    name: webhook?.name || '',
    url: '',
    format: webhook?.format || 'slack',
    events: webhook?.events || ['job.failed', 'schedule.overdue'],
    enabled: webhook?.enabled ?? true,
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)
  const set = (patch) => setForm((f) => ({ ...f, ...patch }))
  const toggleEvent = (e) => set({ events: form.events.includes(e) ? form.events.filter((x) => x !== e) : [...form.events, e] })

  const submit = async (ev) => {
    ev.preventDefault()
    setSaving(true)
    setError(null)
    try {
      const body = { ...form, url: form.url.trim() || undefined }
      onSaved(webhook ? await api.monitoring.updateWebhook(webhook.id, body) : await api.monitoring.createWebhook(body))
    } catch (err) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card className="mb-6">
      <form onSubmit={submit} className="space-y-5">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold text-zinc-200">{webhook ? `Edit “${webhook.name}”` : 'New webhook'}</h2>
          <Toggle checked={form.enabled} onChange={(v) => set({ enabled: v })} label={form.enabled ? 'Enabled' : 'Disabled'} />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className={labelCls}>Name</label>
            <input type="text" value={form.name} maxLength={100} placeholder="#ops-alerts" onChange={(e) => set({ name: e.target.value })} className={inputCls} />
          </div>
          <div>
            <label className={labelCls}>Format</label>
            <select value={form.format} onChange={(e) => set({ format: e.target.value })} className={inputCls}>
              {formats.map((f) => <option key={f} value={f}>{FORMAT_LABELS[f] || f}</option>)}
            </select>
          </div>
          <div className="sm:col-span-2">
            <label className={labelCls}>Webhook URL</label>
            <input type="password" autoComplete="off" value={form.url} onChange={(e) => set({ url: e.target.value })}
              placeholder={webhook ? 'Stored securely — leave blank to keep the current URL' : 'https://hooks.slack.com/services/…'}
              className={`${inputCls} font-mono`} />
            <p className="text-xs text-zinc-600 mt-1">The URL is stored encrypted and never shown again.</p>
          </div>
        </div>
        <fieldset>
          <legend className={labelCls}>Send on</legend>
          <div className="flex flex-wrap gap-4 mt-1">
            {events.map((e) => (
              <label key={e} className="flex items-center gap-2 text-sm text-zinc-300 cursor-pointer">
                <input type="checkbox" checked={form.events.includes(e)} onChange={() => toggleEvent(e)} className="accent-emerald-500" />
                {EVENT_LABELS[e] || e}
              </label>
            ))}
          </div>
        </fieldset>
        {error && <ErrorAlert message={error} />}
        <div className="flex justify-end gap-2 pt-2 border-t border-zinc-800">
          <button type="button" onClick={onCancel} className="px-4 py-2 text-sm font-medium rounded-lg text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 transition-colors">Cancel</button>
          <button type="submit" disabled={saving || !form.name.trim() || (!webhook && !form.url.trim())}
            className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
            {saving && <Spinner size="sm" />}{webhook ? 'Save changes' : 'Add webhook'}
          </button>
        </div>
      </form>
    </Card>
  )
}

function TestResult({ result }) {
  if (!result) return null
  if (result.pending) return <span className="text-xs text-zinc-500">Sending…</span>
  return result.ok
    ? <span className="text-xs text-emerald-400">✓ Delivered</span>
    : <span className="text-xs text-red-400" title={result.error}>✗ {result.error || 'Failed'}</span>
}

function WebhookRow({ w, onEdit, onDelete, onTest, testResult }) {
  const [confirming, setConfirming] = useState(false)
  return (
    <li className="flex flex-wrap items-center gap-4 py-4">
      <div className="flex-1 min-w-48">
        <p className="text-zinc-100 font-medium">
          {w.name}
          {!w.enabled && <span className="ml-2 text-xs text-zinc-500 font-normal">(disabled)</span>}
        </p>
        <p className="text-xs text-zinc-500 mt-0.5">
          {FORMAT_LABELS[w.format] || w.format} · {w.events.length ? w.events.map((e) => EVENT_LABELS[e] || e).join(', ') : 'no events'}
          {!w.configured && <span className="text-amber-400"> · URL missing</span>}
        </p>
      </div>
      <TestResult result={testResult} />
      {confirming ? (
        <div className="flex items-center gap-2">
          <span className="text-xs text-red-400">Delete?</span>
          <Button size="sm" variant="danger" onClick={() => onDelete(w)}>Delete</Button>
          <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>Cancel</Button>
        </div>
      ) : (
        <div className="flex items-center gap-1.5">
          <Button size="sm" variant="secondary" disabled={testResult?.pending} onClick={() => onTest(w)}>Send test</Button>
          <Button size="sm" variant="ghost" onClick={() => onEdit(w)}>Edit</Button>
          <Button size="sm" variant="ghost" onClick={() => setConfirming(true)}>Delete</Button>
        </div>
      )}
    </li>
  )
}

/** Admin page: notification webhooks (Slack, Discord, Teams, generic JSON). */
export default function Notifications() {
  const { data, loading, error, reload } = useFetch(() => api.monitoring.settings())
  const [editing, setEditing] = useState(null) // null | 'new' | webhook
  const [tests, setTests] = useState({})
  const [actionError, setActionError] = useState(null)

  const onTest = async (w) => {
    setTests((t) => ({ ...t, [w.id]: { pending: true } }))
    try {
      const result = await api.monitoring.testWebhook(w.id)
      setTests((t) => ({ ...t, [w.id]: result }))
    } catch (err) {
      setTests((t) => ({ ...t, [w.id]: { ok: false, error: err.message } }))
    }
  }

  const onDelete = async (w) => {
    setActionError(null)
    try {
      await api.monitoring.deleteWebhook(w.id)
      reload()
    } catch (err) {
      setActionError(err.message)
    }
  }

  const webhooks = data?.webhooks || []
  return (
    <div className="p-8 max-w-4xl">
      <PageHeader title="Notifications" subtitle="Webhooks for failed backups, successes and overdue schedules"
        action={!editing && data && <Button onClick={() => setEditing('new')}>+ Add webhook</Button>} />
      {editing && (
        <WebhookForm key={editing === 'new' ? 'new' : editing.id} webhook={editing === 'new' ? null : editing}
          formats={data.formats} events={data.events}
          onCancel={() => setEditing(null)} onSaved={() => { setEditing(null); reload() }} />
      )}
      {actionError && <div className="mb-4"><ErrorAlert message={actionError} /></div>}
      {loading && !data ? (
        <div className="flex justify-center py-16"><Spinner /></div>
      ) : error ? (
        <ErrorAlert message={error} onRetry={reload} />
      ) : webhooks.length === 0 ? (
        <EmptyState icon="🔔" title="No webhooks" description="Add a Slack, Discord, Teams or generic webhook to get alerted about failed backups." />
      ) : (
        <Card className="py-0">
          <ul className="divide-y divide-zinc-800/60">
            {webhooks.map((w) => (
              <WebhookRow key={w.id} w={w} testResult={tests[w.id]} onTest={onTest} onDelete={onDelete} onEdit={setEditing} />
            ))}
          </ul>
        </Card>
      )}
    </div>
  )
}
