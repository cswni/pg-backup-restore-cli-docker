import React, { useState, useId } from 'react'
import { CircleCheck, KeyRound, Trash2, TriangleAlert } from 'lucide-react'
import { api } from '../../lib/api'
import { Button, ErrorAlert, BusyIcon, Icon } from '../UI'
import Modal, { ModalFooter } from '../Modal'

// Edit dialog for the credentials saved for one container key (a container
// name, or a Swarm service name). Passwords are write-only: the API only says
// whether one is configured.

const INPUT = 'w-full bg-zinc-800 border border-zinc-500 focus:border-emerald-500 rounded-lg px-3 py-2 text-sm font-mono text-zinc-100 placeholder-zinc-400 outline-hidden transition-colors disabled:opacity-50'
const LABEL = 'block text-xs text-zinc-400 mb-1 font-medium uppercase tracking-wider'
const TAP = 'max-sm:min-h-[44px]'

const ENGINES = {
  postgres: { label: 'PostgreSQL', user: 'postgres' },
  mysql: { label: 'MySQL / MariaDB', user: 'root' },
  mongodb: { label: 'MongoDB', user: '' },
}

// Same rule as ui/server/containercreds/store.js: Swarm task containers
// (<service>.<slot>.<25-char task id>) share their service's credentials.
const SWARM_TASK_RE = /^(.+)\.\d+\.[a-z0-9]{25}$/

export function credentialKeyFor(containerName) {
  const match = SWARM_TASK_RE.exec(containerName)
  return match ? match[1] : containerName
}

function Field({ id, label, hint, children }) {
  return (
    <div>
      <label htmlFor={id} className={LABEL}>{label}</label>
      {children}
      {hint && <p id={`${id}-hint`} className="text-xs text-zinc-400 mt-1">{hint}</p>}
    </div>
  )
}

function initialForm(saved, engine) {
  return {
    engine: saved?.engine || engine || 'postgres',
    username: saved?.username || '',
    password: '',
    clearPassword: false,
    osUser: saved ? (saved.osUser ?? 'postgres') : 'postgres',
    host: saved?.host || '',
    authSource: saved?.authSource || 'admin',
  }
}

function toPayload(form) {
  const body = { engine: form.engine, username: form.username.trim(), password: form.clearPassword ? null : form.password }
  if (form.engine === 'postgres') return { ...body, osUser: form.osUser.trim(), host: form.host.trim() }
  if (form.engine === 'mongodb') return { ...body, authSource: form.authSource.trim() }
  return body
}

function TestResult({ result }) {
  if (!result) return null
  const ok = result.ok
  return (
    <p role={ok ? 'status' : 'alert'} className={`flex items-start gap-1.5 text-sm break-words ${ok ? 'text-emerald-400' : 'text-red-400'}`}>
      <Icon as={ok ? CircleCheck : TriangleAlert} className="size-4 mt-0.5" />
      <span>{ok ? `Signed in. ${result.databases} database(s) found.` : result.error}</span>
    </p>
  )
}

/**
 * @param {{ serverId: string, serverName: string, credentialKey: string, container?: string,
 *   engine?: string, saved?: object|null, onClose: () => void, onChanged: (record: object|null) => void }} props
 *   `container` is a running container to test with; `saved` is the public record, if any.
 */
export default function CredentialsDialog({ serverId, serverName, credentialKey, container, engine, saved: savedProp, onClose, onChanged }) {
  const [saved, setSaved] = useState(savedProp || null)
  const [form, setForm] = useState(() => initialForm(savedProp, engine))
  const [baseline, setBaseline] = useState(() => JSON.stringify(initialForm(savedProp, engine)))
  const [busy, setBusy] = useState(null)
  const [error, setError] = useState(null)
  const [testResult, setTestResult] = useState(null)
  const id = useId()
  const set = (key) => (value) => setForm((f) => ({ ...f, [key]: value }))
  const dirty = !saved || JSON.stringify(form) !== baseline
  const defaults = ENGINES[form.engine]

  async function persist() {
    const record = await api.containerCredentials.save(serverId, credentialKey, toPayload(form))
    const next = initialForm(record)
    setSaved(record)
    setForm(next)
    setBaseline(JSON.stringify(next))
    onChanged(record)
    return record
  }

  async function run(kind, fn) {
    setBusy(kind)
    setError(null)
    try {
      await fn()
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(null)
    }
  }

  const save = () => run('save', async () => { await persist(); onClose() })

  const test = () => run('test', async () => {
    setTestResult(null)
    if (dirty) await persist()
    setTestResult(await api.containerCredentials.test(serverId, credentialKey, container))
  })

  const remove = () => {
    if (!window.confirm(`Delete the saved credentials for ${credentialKey}? The container's own environment is used again.`)) return
    run('delete', async () => {
      await api.containerCredentials.remove(serverId, credentialKey)
      onChanged(null)
      onClose()
    })
  }

  const keyNote = container && container !== credentialKey
    ? `Applies to the Swarm service ${credentialKey}, so it survives redeploys.`
    : `${credentialKey} on ${serverName}`

  return (
    <Modal icon={KeyRound} title="Container credentials" subtitle={keyNote} subtitleClassName="break-all" size="lg" onClose={onClose}>
      <form id={`${id}-form`} className="px-6 py-5 space-y-4" onSubmit={(e) => { e.preventDefault(); if (dirty && !busy) save() }}>
        <p className="text-sm text-zinc-400">
          Used instead of the container's own environment for backups, restores, database lists and the Explorer.
        </p>

        <Field id={`${id}-engine`} label="Engine">
          <select id={`${id}-engine`} value={form.engine} onChange={(e) => set('engine')(e.target.value)} className={INPUT}>
            {Object.entries(ENGINES).map(([value, d]) => <option key={value} value={value}>{d.label}</option>)}
          </select>
        </Field>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field id={`${id}-user`} label="Username">
            <input id={`${id}-user`} value={form.username} onChange={(e) => set('username')(e.target.value)} className={INPUT}
              placeholder={defaults.user} autoComplete="off" spellCheck={false} required={!defaults.user} />
          </Field>
          <Field id={`${id}-password`} label="Password">
            <input id={`${id}-password`} type="password" value={form.password} onChange={(e) => set('password')(e.target.value)}
              className={INPUT} autoComplete="new-password" disabled={form.clearPassword}
              placeholder={saved?.passwordConfigured ? '•••• configured' : ''} />
          </Field>
        </div>
        {saved?.passwordConfigured && (
          <label className="flex items-center gap-2 min-h-[44px] -my-2 text-sm text-zinc-300 cursor-pointer">
            <input type="checkbox" checked={form.clearPassword} onChange={(e) => set('clearPassword')(e.target.checked)}
              className="size-4 accent-emerald-500" />
            Clear the saved password
          </label>
        )}
        {saved?.passwordConfigured && !form.clearPassword && (
          <p className="text-xs text-zinc-400 -mt-2">Leave the password empty to keep the saved one.</p>
        )}

        {form.engine === 'postgres' && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Field id={`${id}-os`} label="OS user" hint="Runs the PostgreSQL tools as this user (docker exec -u). Leave it empty when the image has no postgres user.">
              <input id={`${id}-os`} value={form.osUser} onChange={(e) => set('osUser')(e.target.value)} className={INPUT}
                aria-describedby={`${id}-os-hint`} autoComplete="off" spellCheck={false} />
            </Field>
            <Field id={`${id}-host`} label="Host" hint="Use 127.0.0.1 to log in with the password over TCP. Empty uses the local socket.">
              <input id={`${id}-host`} value={form.host} onChange={(e) => set('host')(e.target.value)} className={INPUT}
                aria-describedby={`${id}-host-hint`} placeholder="127.0.0.1" autoComplete="off" spellCheck={false} />
            </Field>
          </div>
        )}

        {form.engine === 'mongodb' && (
          <Field id={`${id}-auth`} label="Auth database" hint="Database the user is defined in, usually admin.">
            <input id={`${id}-auth`} value={form.authSource} onChange={(e) => set('authSource')(e.target.value)} className={INPUT}
              aria-describedby={`${id}-auth-hint`} autoComplete="off" spellCheck={false} />
          </Field>
        )}

        {!container && <p className="text-xs text-zinc-400">No running container uses these credentials, so they cannot be tested right now.</p>}
        <TestResult result={testResult} />
        {error && <ErrorAlert message={error} />}
      </form>

      <ModalFooter>
        {saved && (
          <Button variant="ghost" className={`mr-auto text-red-400 hover:text-red-300 ${TAP}`} disabled={!!busy} onClick={remove}>
            {busy === 'delete' ? <BusyIcon /> : <Icon as={Trash2} />} Delete
          </Button>
        )}
        <Button variant="ghost" className={TAP} onClick={onClose}>Cancel</Button>
        {container && (
          <Button variant="secondary" className={TAP} disabled={!!busy} onClick={test}>
            {busy === 'test' ? <><BusyIcon /> Testing…</> : dirty ? 'Save and test' : 'Test'}
          </Button>
        )}
        <Button type="submit" form={`${id}-form`} variant="primary" className={TAP} disabled={!!busy || !dirty}>
          {busy === 'save' ? <><BusyIcon /> Saving…</> : 'Save'}
        </Button>
      </ModalFooter>
    </Modal>
  )
}
