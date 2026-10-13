import React, { useState } from 'react'
import { Card, Button, Toggle } from '../UI'
import { Label, TextField, SectionTitle, Notice } from './fields'

const MIN_PASSPHRASE = 12

export function CompressionCard({ settings, onSave }) {
  const [enabled, setEnabled] = useState(settings.compression.enabled)
  const [level, setLevel] = useState(settings.compression.level)
  const [saving, setSaving] = useState(false)
  const dirty = enabled !== settings.compression.enabled || level !== settings.compression.level

  async function save() {
    setSaving(true)
    try { await onSave({ compression: { enabled, level } }) } finally { setSaving(false) }
  }

  return (
    <Card>
      <SectionTitle icon="🗜️" title="Compression" subtitle="Streaming gzip of new backups (.sql → .sql.gz). Can be overridden per export." />
      <div className="space-y-4">
        <Toggle checked={enabled} onChange={setEnabled} label="Compress new backups by default" />
        <div className={enabled ? '' : 'opacity-40 pointer-events-none'}>
          <Label hint={`— ${level} (1 = fastest, 9 = smallest)`}>Level</Label>
          <input
            type="range" min={1} max={9} value={level}
            onChange={(e) => setLevel(Number(e.target.value))}
            className="w-full accent-emerald-500"
            aria-label="Compression level"
          />
        </div>
        <div className="flex justify-end">
          <Button size="sm" disabled={!dirty || saving} onClick={save}>{saving ? 'Saving…' : 'Save'}</Button>
        </div>
      </div>
    </Card>
  )
}

function PassphraseStatus({ encryption }) {
  if (encryption.passphraseSource === 'env') {
    return <Notice tone="success">🔑 Passphrase provided by the <span className="font-mono">BACKUP_ENCRYPTION_PASSPHRASE</span> environment variable (it overrides the stored one).</Notice>
  }
  if (encryption.passphraseConfigured) {
    return (
      <Notice tone="success">
        🔑 A passphrase is configured.
        {encryption.previousPassphrases > 0 && ` ${encryption.previousPassphrases} previous passphrase(s) are kept so older backups can still be restored.`}
      </Notice>
    )
  }
  return <Notice>No passphrase configured yet — encryption is unavailable.</Notice>
}

export function EncryptionCard({ settings, onSave }) {
  const { encryption } = settings
  const [enabled, setEnabled] = useState(encryption.enabled)
  const [passphrase, setPassphrase] = useState('')
  const [confirm, setConfirm] = useState('')
  const [acknowledged, setAcknowledged] = useState(false)
  const [saving, setSaving] = useState(false)

  const changingPass = passphrase.length > 0
  const passOk = !changingPass || (passphrase.length >= MIN_PASSPHRASE && passphrase === confirm && acknowledged)
  const canEnable = !enabled || encryption.passphraseConfigured || (changingPass && passOk)
  const dirty = enabled !== encryption.enabled || changingPass

  async function save() {
    setSaving(true)
    try {
      await onSave({ encryption: { enabled, ...(changingPass ? { passphrase } : {}) } })
      setPassphrase('')
      setConfirm('')
      setAcknowledged(false)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card>
      <SectionTitle icon="🔒" title="Encryption" subtitle="AES-256-GCM with a key derived from your passphrase (scrypt, random salt per file). Adds .enc." />
      <div className="space-y-4">
        <Notice tone="warn">
          <strong className="font-semibold">⚠️ Keep the passphrase somewhere safe, outside this server.</strong> Encrypted
          backups cannot be restored without it — not by this app, not by anyone. If this server is lost, you will need
          the passphrase and the offline decryption tool (<span className="font-mono">node /ui/server/storage/decrypt-cli.js</span>, see README).
        </Notice>
        <PassphraseStatus encryption={encryption} />
        <Toggle checked={enabled} onChange={setEnabled} label="Encrypt new backups by default" hint="Can be overridden per export." />

        <div className="grid sm:grid-cols-2 gap-3">
          <TextField
            label={encryption.passphraseConfigured ? 'New passphrase' : 'Passphrase'}
            hint={`(min ${MIN_PASSPHRASE} chars)`}
            type="password" autoComplete="new-password" value={passphrase} onChange={setPassphrase}
          />
          <TextField label="Confirm passphrase" type="password" autoComplete="new-password" value={confirm} onChange={setConfirm} />
        </div>
        {changingPass && passphrase.length < MIN_PASSPHRASE && <p className="text-xs text-red-400">At least {MIN_PASSPHRASE} characters.</p>}
        {changingPass && confirm && passphrase !== confirm && <p className="text-xs text-red-400">Passphrases do not match.</p>}
        {changingPass && (
          <Toggle
            danger
            checked={acknowledged}
            onChange={setAcknowledged}
            label="I have stored this passphrase safely"
            hint={encryption.passphraseConfigured
              ? 'New backups will use the new passphrase. The old one is kept for older backups — keep your own copy of it too.'
              : 'Losing it makes every encrypted backup unrecoverable.'}
          />
        )}
        <div className="flex justify-end">
          <Button size="sm" disabled={!dirty || !passOk || !canEnable || saving} onClick={save}>{saving ? 'Saving…' : 'Save'}</Button>
        </div>
      </div>
    </Card>
  )
}
