import React, { useState } from 'react'
import { Card, Button } from '../UI'
import { CountField, Label, SectionTitle, Notice } from './fields'

/** "keep last N and/or D days" inputs, used for local files and destinations. */
export function RetentionFields({ value, onChange }) {
  return (
    <div className="grid grid-cols-2 gap-3">
      <CountField label="Newest N" hint="backups" value={value.keepLast} onChange={(keepLast) => onChange({ ...value, keepLast })} />
      <CountField label="Max age" hint="days" value={value.keepDays} max={36500} onChange={(keepDays) => onChange({ ...value, keepDays })} />
    </div>
  )
}

export function describeRetention(policy) {
  const parts = []
  if (policy?.keepLast) parts.push(`last ${policy.keepLast}`)
  if (policy?.keepDays) parts.push(`${policy.keepDays} days`)
  return parts.length ? `keep ${parts.join(' + ')}` : 'keep forever'
}

export function RetentionCard({ settings, onSave, onRun }) {
  const [local, setLocal] = useState(settings.retention.local)
  const [policy, setPolicy] = useState(settings.upload.failurePolicy)
  const [saving, setSaving] = useState(false)
  const [running, setRunning] = useState(false)

  const saved = settings.retention.local
  const dirty = local.keepLast !== saved.keepLast || local.keepDays !== saved.keepDays || policy !== settings.upload.failurePolicy

  async function save() {
    setSaving(true)
    try { await onSave({ retention: { local }, upload: { failurePolicy: policy } }) } finally { setSaving(false) }
  }

  async function run() {
    setRunning(true)
    try { await onRun() } finally { setRunning(false) }
  }

  return (
    <Card>
      <SectionTitle icon="🧹" title="Retention & uploads" subtitle="Applied after every backup and once a day, per database (same server, container and source database)." />
      <div className="space-y-4">
        <div>
          <p className="text-sm text-zinc-300 mb-2">Local files in /backups</p>
          <RetentionFields value={local} onChange={setLocal} />
        </div>
        <Notice>
          A backup is deleted only when it is outside <em>every</em> rule. The newest copy of each database and the backup
          just created are never deleted. Local files that still have cloud copies stay listed and restorable.
          Per-destination rules are set on each destination.
        </Notice>
        <div>
          <Label>When an upload fails</Label>
          <select
            value={policy}
            onChange={(e) => setPolicy(e.target.value)}
            className="w-full bg-zinc-800 border border-zinc-700 focus:border-emerald-500 rounded-lg px-3 py-2 text-sm text-zinc-100 outline-hidden transition-colors"
          >
            <option value="fail">Fail the backup job (local file is kept)</option>
            <option value="best-effort">Best effort — log a warning and succeed</option>
          </select>
        </div>
        <div className="flex justify-between gap-2">
          <Button size="sm" variant="secondary" disabled={running} onClick={run}>{running ? 'Starting…' : '▶ Run retention now'}</Button>
          <Button size="sm" disabled={!dirty || saving} onClick={save}>{saving ? 'Saving…' : 'Save'}</Button>
        </div>
      </div>
    </Card>
  )
}
