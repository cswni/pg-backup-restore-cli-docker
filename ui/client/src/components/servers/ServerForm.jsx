import React, { useState, useId } from 'react'
import { Server } from 'lucide-react'
import { Button, Toggle, ErrorAlert, BusyIcon } from '../UI'
import Modal, { ModalFooter } from '../Modal'

// Add / edit dialog for a remote Docker host (over SSH) or a direct database
// connection with an optional SSH tunnel. Secrets are never sent back by the
// API: empty secret fields keep the stored value ("•••• configured").

const INPUT = 'w-full bg-zinc-800 border border-zinc-500 focus:border-emerald-500 rounded-lg px-3 py-2 text-sm text-zinc-100 placeholder-zinc-400 outline-hidden transition-colors'
const LABEL = 'block text-xs text-zinc-400 mb-1 font-medium uppercase tracking-wider'
const SSL_MODES = ['disable', 'prefer', 'require', 'verify-full']
const KEY_HINT = 'Unencrypted private key (passphrases are not supported, so use a dedicated deploy key).'

/** Label + control; `id` must also be passed to the control. */
function Field({ id, label, children, className = '' }) {
  return (
    <div className={className}>
      <label htmlFor={id} className={LABEL}>{label}</label>
      {children}
    </div>
  )
}

function TextInput({ value, onChange, mono = true, ...rest }) {
  return <input {...rest} value={value ?? ''} onChange={(e) => onChange(e.target.value)} className={`${INPUT} ${mono ? 'font-mono' : ''}`} />
}

function KeyInput({ id, value, onChange, configured }) {
  return (
    <>
      <textarea
        id={id}
        aria-describedby={`${id}-hint`}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={4}
        spellCheck={false}
        placeholder={configured ? '•••• configured (leave empty to keep)' : '-----BEGIN OPENSSH PRIVATE KEY-----\n…'}
        className={`${INPUT} font-mono text-xs resize-y`}
      />
      <p id={`${id}-hint`} className="text-xs text-zinc-400 mt-1">{KEY_HINT}</p>
    </>
  )
}

/** SSH host/port/user/key fields shared by Docker hosts and tunnels. */
function SshFields({ value, onChange, configured, hostLabel = 'SSH host', hostPlaceholder = 'docker.example.com' }) {
  const set = (k) => (v) => onChange({ ...value, [k]: v })
  const id = useId()
  return (
    <div className="grid grid-cols-1 sm:grid-cols-6 gap-3">
      <Field id={`${id}-host`} label={hostLabel} className="sm:col-span-4"><TextInput id={`${id}-host`} value={value.host} onChange={set('host')} placeholder={hostPlaceholder} /></Field>
      <Field id={`${id}-port`} label="Port" className="sm:col-span-2"><TextInput id={`${id}-port`} value={value.port} onChange={set('port')} placeholder="22" inputMode="numeric" /></Field>
      <Field id={`${id}-user`} label="User" className="sm:col-span-6"><TextInput id={`${id}-user`} value={value.user} onChange={set('user')} placeholder="deploy" /></Field>
      <Field id={`${id}-key`} label="Private key" className="sm:col-span-6"><KeyInput id={`${id}-key`} value={value.privateKey} onChange={set('privateKey')} configured={configured} /></Field>
    </div>
  )
}

// Per-engine defaults: port, maintenance database (MongoDB: authSource) and user placeholder
const ENGINE_DEFAULTS = {
  postgres: { label: 'PostgreSQL', port: 5432, database: 'postgres', user: 'postgres', dbLabel: 'Maintenance database' },
  mysql: { label: 'MySQL / MariaDB', port: 3306, database: 'mysql', user: 'root', dbLabel: 'Default database' },
  mongodb: { label: 'MongoDB', port: 27017, database: 'admin', user: 'root', dbLabel: 'Auth database' },
}

/** Switch engine; port and database follow when they still hold the old engine's defaults. */
function switchEngine(form, engine) {
  const before = ENGINE_DEFAULTS[form.engine]
  const after = ENGINE_DEFAULTS[engine]
  return {
    ...form,
    engine,
    port: !form.port || String(form.port) === String(before.port) ? after.port : form.port,
    database: !form.database || form.database === before.database ? after.database : form.database,
  }
}

function DirectFields({ form, set, setForm, server }) {
  const defaults = ENGINE_DEFAULTS[form.engine] || ENGINE_DEFAULTS.postgres
  const id = useId()
  return (
    <div className="grid grid-cols-1 sm:grid-cols-6 gap-3">
      <Field id={`${id}-engine`} label="Engine" className="sm:col-span-2">
        <select id={`${id}-engine`} value={form.engine} onChange={(e) => setForm((f) => switchEngine(f, e.target.value))} className={INPUT}>
          {Object.entries(ENGINE_DEFAULTS).map(([id, d]) => <option key={id} value={id}>{d.label}</option>)}
        </select>
      </Field>
      <Field id={`${id}-host`} label="Host" className="sm:col-span-3"><TextInput id={`${id}-host`} value={form.host} onChange={set('host')} placeholder="db.example.com" /></Field>
      <Field id={`${id}-port`} label="Port" className="sm:col-span-1"><TextInput id={`${id}-port`} value={form.port} onChange={set('port')} placeholder={String(defaults.port)} inputMode="numeric" /></Field>
      <Field id={`${id}-user`} label="Username" className="sm:col-span-3"><TextInput id={`${id}-user`} value={form.username} onChange={set('username')} placeholder={defaults.user} autoComplete="off" /></Field>
      <Field id={`${id}-password`} label="Password" className="sm:col-span-3">
        <TextInput id={`${id}-password`} type="password" value={form.password} onChange={set('password')} autoComplete="new-password"
          placeholder={server?.passwordConfigured ? '•••• configured' : ''} />
      </Field>
      <Field id={`${id}-db`} label={defaults.dbLabel} className="sm:col-span-3"><TextInput id={`${id}-db`} value={form.database} onChange={set('database')} placeholder={defaults.database} /></Field>
      <Field id={`${id}-ssl`} label="SSL mode" className="sm:col-span-3">
        <select id={`${id}-ssl`} value={form.sslmode} onChange={(e) => set('sslmode')(e.target.value)} className={INPUT}>
          {SSL_MODES.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
      </Field>
    </div>
  )
}

/** Form state from an existing (public) server, or defaults for a new one. */
function initialForm(server) {
  const ssh = server?.ssh || {}
  const tunnel = server?.tunnel || {}
  return {
    kind: server?.kind || 'docker',
    name: server?.name || '',
    ssh: { host: ssh.host || '', port: ssh.port || 22, user: ssh.user || '', privateKey: '' },
    engine: server?.engine || 'postgres',
    host: server?.host || '',
    port: server?.port || 5432,
    username: server?.username || '',
    password: '',
    database: server?.database || 'postgres',
    sslmode: server?.sslmode || 'prefer',
    tunnelEnabled: !!server?.tunnel,
    tunnel: { host: tunnel.host || '', port: tunnel.port || 22, user: tunnel.user || '', privateKey: '' },
  }
}

/** Request body for POST/PUT /api/servers. */
function toPayload(form) {
  if (form.kind === 'docker') return { kind: 'docker', name: form.name, ssh: form.ssh }
  const { ssh, tunnelEnabled, tunnel, ...direct } = form
  return { ...direct, tunnel: tunnelEnabled ? { ...tunnel, enabled: true } : null }
}

function KindPicker({ kind, onChange }) {
  const options = [
    { id: 'docker', title: 'Docker host over SSH', desc: 'Containers on another machine, same workflow as the local socket' },
    { id: 'direct', title: 'Direct database', desc: 'Host / port / user, optionally through an SSH tunnel' },
  ]
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
      {options.map((o) => (
        <button key={o.id} type="button" aria-pressed={kind === o.id} onClick={() => onChange(o.id)}
          className={`text-left p-3 rounded-xl border transition-colors ${kind === o.id
            ? 'border-emerald-500/50 bg-emerald-500/10' : 'border-zinc-700 hover:border-zinc-500 bg-zinc-800/40'}`}>
          <p className="text-sm font-medium text-zinc-100">{o.title}</p>
          <p className="text-xs text-zinc-400 mt-0.5">{o.desc}</p>
        </button>
      ))}
    </div>
  )
}

/**
 * @param {{ server?: object, onClose: () => void, onSave: (payload: object) => Promise<void> }} props
 *   `server` is the public server when editing, undefined when adding.
 */
export default function ServerForm({ server, onClose, onSave }) {
  const [form, setForm] = useState(() => initialForm(server))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)
  const set = (k) => (v) => setForm((f) => ({ ...f, [k]: v }))
  const isEdit = !!server

  async function submit() {
    setSaving(true)
    setError(null)
    try {
      await onSave(toPayload(form))
    } catch (err) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  const nameId = useId()
  return (
    <Modal icon={Server} title={isEdit ? `Edit ${server.name}` : 'Add server'} size="xl" onClose={onClose}>
      <div className="px-6 py-5 space-y-5">
        {!isEdit && <KindPicker kind={form.kind} onChange={set('kind')} />}
        <Field id={nameId} label="Name"><TextInput id={nameId} mono={false} value={form.name} onChange={set('name')} placeholder="e.g. Production" /></Field>

        {form.kind === 'docker' && (
          <SshFields value={form.ssh} onChange={set('ssh')} configured={server?.ssh?.keyConfigured} />
        )}

        {form.kind === 'direct' && (
          <>
            <DirectFields form={form} set={set} setForm={setForm} server={server} />
            <Toggle checked={form.tunnelEnabled} onChange={set('tunnelEnabled')} label="Connect through an SSH tunnel"
              hint="The database host and port are then resolved from the bastion host." />
            {form.tunnelEnabled && (
              <SshFields value={form.tunnel} onChange={set('tunnel')} configured={server?.tunnel?.keyConfigured} hostLabel="Bastion host" hostPlaceholder="bastion.example.com" />
            )}
          </>
        )}

        {error && <ErrorAlert message={error} />}
      </div>

      <ModalFooter>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={saving || !form.name.trim()} onClick={submit}>
          {saving ? <><BusyIcon /> Saving…</> : isEdit ? 'Save changes' : 'Add server'}
        </Button>
      </ModalFooter>
    </Modal>
  )
}
