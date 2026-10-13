import React, { useEffect, useMemo, useState } from 'react'
import { api } from '../lib/api'
import { Card, DbNameInput, Toggle, ErrorAlert, Spinner, DB_NAME_PATTERN } from './UI'
import CronPicker, { inputCls, labelCls } from './CronPicker'
import { DEFAULT_PRESET, buildCron } from '../lib/cron'

const BROWSER_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
const TIMEZONES = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : []

function initialForm(schedule) {
  const opts = schedule?.options || {}
  return {
    name: schedule?.name || '',
    enabled: schedule?.enabled ?? true,
    cron: schedule?.cron || buildCron(DEFAULT_PRESET),
    timezone: schedule?.timezone || BROWSER_TZ,
    serverId: schedule?.serverId || 'local',
    engine: schedule?.engine || 'postgres',
    container: schedule?.container || '',
    database: schedule?.database || '',
    outputName: schedule?.outputName || '',
    compress: !!opts.compress,
    encrypt: !!opts.encrypt,
    destinations: Array.isArray(opts.destinations) ? opts.destinations.join(', ') : '',
    extraOptions: Object.fromEntries(Object.entries(opts).filter(([k]) => !['compress', 'encrypt', 'destinations'].includes(k))),
  }
}

/** Request body for the API (options are passed through to the backup pipeline). */
function toPayload(f) {
  const destinations = f.destinations.split(',').map((d) => d.trim()).filter(Boolean)
  return {
    name: f.name.trim(),
    enabled: f.enabled,
    cron: f.cron,
    timezone: f.timezone,
    serverId: f.serverId,
    engine: f.engine,
    container: f.container || null,
    database: f.database,
    outputName: f.outputName || null,
    options: {
      ...f.extraOptions,
      compress: f.compress,
      encrypt: f.encrypt,
      ...(destinations.length ? { destinations } : {}),
    },
  }
}

/** Servers, engines, containers and databases for the target pickers. */
function useTargetOptions(serverId, container, engine) {
  const [servers, setServers] = useState([])
  const [engines, setEngines] = useState([])
  const [containers, setContainers] = useState([])
  const [databases, setDatabases] = useState([])

  useEffect(() => {
    api.servers.list().then(setServers).catch(() => setServers([]))
    api.engines.list().then(setEngines).catch(() => setEngines([]))
  }, [])
  useEffect(() => {
    let cancelled = false
    api.containers.list(serverId).then((c) => { if (!cancelled) setContainers(c) }).catch(() => { if (!cancelled) setContainers([]) })
    return () => { cancelled = true }
  }, [serverId])
  useEffect(() => {
    let cancelled = false
    if (!container) return undefined
    api.containers.databases(container, { serverId, engine })
      .then((d) => { if (!cancelled) setDatabases(d) })
      .catch(() => { if (!cancelled) setDatabases([]) })
    return () => { cancelled = true }
  }, [serverId, container, engine])

  return { servers, engines, containers, databases: container ? databases : [] }
}

function Field({ label, children, className = '' }) {
  return (
    <div className={className}>
      <label className={labelCls}>{label}</label>
      {children}
    </div>
  )
}

function TargetFields({ form, set }) {
  const { servers, engines, containers, databases } = useTargetOptions(form.serverId, form.container, form.engine)
  const server = servers.find((s) => s.id === form.serverId)
  const needsContainer = !server || server.kind === 'docker'
  const pickContainer = (name) => {
    const c = containers.find((x) => x.name === name)
    set({ container: name, ...(c?.engine ? { engine: c.engine } : {}) })
  }
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
      <Field label="Server">
        <select value={form.serverId} onChange={(e) => set({ serverId: e.target.value, container: '' })} className={inputCls}>
          {(servers.length ? servers : [{ id: 'local', name: 'Local Docker' }]).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      </Field>
      <Field label="Engine">
        <select value={form.engine} onChange={(e) => set({ engine: e.target.value })} className={inputCls}>
          {(engines.length ? engines : [{ engine: 'postgres', label: 'PostgreSQL' }]).map((e) => <option key={e.engine} value={e.engine}>{e.label}</option>)}
        </select>
      </Field>
      {needsContainer && (
        <Field label="Container">
          <input type="text" list="schedule-containers" value={form.container} placeholder="container name"
            onChange={(e) => pickContainer(e.target.value.trim())} className={`${inputCls} font-mono`} />
          <datalist id="schedule-containers">{containers.map((c) => <option key={c.id} value={c.name} />)}</datalist>
        </Field>
      )}
      <Field label="Database">
        <DbNameInput id="schedule-db" value={form.database} onChange={(v) => set({ database: v })} options={databases} />
      </Field>
      <Field label="Output name (optional)">
        <DbNameInput id="schedule-output" value={form.outputName} onChange={(v) => set({ outputName: v })} placeholder="defaults to the database name" />
      </Field>
    </div>
  )
}

/**
 * Create/edit form for a backup schedule.
 * @param {{ schedule?: object, onSaved: (s: object) => void, onCancel: () => void }} props
 */
export default function ScheduleForm({ schedule, onSaved, onCancel }) {
  const [form, setForm] = useState(() => initialForm(schedule))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)
  const set = (patch) => setForm((f) => ({ ...f, ...patch }))

  const invalid = useMemo(() => !form.name.trim() || !DB_NAME_PATTERN.test(form.database) ||
    (form.outputName && !DB_NAME_PATTERN.test(form.outputName)) || !form.cron, [form])

  const submit = async (e) => {
    e.preventDefault()
    setSaving(true)
    setError(null)
    try {
      const payload = toPayload(form)
      onSaved(schedule ? await api.schedules.update(schedule.id, payload) : await api.schedules.create(payload))
    } catch (err) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card className="mb-6">
      <form onSubmit={submit} className="space-y-6">
        <div className="flex items-center justify-between gap-4">
          <h2 className="font-semibold text-zinc-200">{schedule ? `Edit “${schedule.name}”` : 'New schedule'}</h2>
          <Toggle checked={form.enabled} onChange={(v) => set({ enabled: v })} label={form.enabled ? 'Enabled' : 'Disabled'} />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field label="Name">
            <input type="text" value={form.name} maxLength={100} placeholder="Nightly production" onChange={(e) => set({ name: e.target.value })} className={inputCls} />
          </Field>
          <Field label="Timezone">
            <input type="text" list="schedule-timezones" value={form.timezone} onChange={(e) => set({ timezone: e.target.value.trim() })} className={inputCls} />
            <datalist id="schedule-timezones">{TIMEZONES.map((tz) => <option key={tz} value={tz} />)}</datalist>
          </Field>
        </div>
        <section>
          <h3 className="text-sm font-medium text-zinc-300 mb-3">When</h3>
          <CronPicker cron={form.cron} timezone={form.timezone || 'UTC'} onChange={(cron) => set({ cron })} />
        </section>
        <section>
          <h3 className="text-sm font-medium text-zinc-300 mb-3">What</h3>
          <TargetFields form={form} set={set} />
        </section>
        <section className="space-y-3">
          <h3 className="text-sm font-medium text-zinc-300">Options</h3>
          <Toggle checked={form.compress} onChange={(v) => set({ compress: v })} label="Compress" hint="Applied when the storage module supports it." />
          <Toggle checked={form.encrypt} onChange={(v) => set({ encrypt: v })} label="Encrypt" hint="Uses the configured encryption key." />
          <Field label="Remote destinations (comma separated, optional)">
            <input type="text" value={form.destinations} placeholder="e.g. s3-offsite" onChange={(e) => set({ destinations: e.target.value })} className={inputCls} />
          </Field>
        </section>
        {error && <ErrorAlert message={error} />}
        <div className="flex items-center justify-end gap-2 pt-2 border-t border-zinc-800">
          {/* UI Button has no type prop (defaults to submit inside a form) */}
          <button type="button" onClick={onCancel}
            className="px-4 py-2 text-sm font-medium rounded-lg text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 transition-colors">
            Cancel
          </button>
          <button type="submit" disabled={saving || invalid}
            className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
            {saving && <Spinner size="sm" />}{schedule ? 'Save changes' : 'Create schedule'}
          </button>
        </div>
      </form>
    </Card>
  )
}
