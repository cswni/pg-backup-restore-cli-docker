import React, { useState } from 'react'
import { HardDrive } from 'lucide-react'
import { Button, Toggle, ErrorAlert } from '../UI'
import { TextField, CopyField, Notice } from './fields'
import { RetentionFields } from './RetentionCard'
import Modal, { ModalFooter } from '../Modal'

const S3_EMPTY = { endpoint: '', region: 'us-east-1', bucket: '', prefix: '', accessKeyId: '', secretAccessKey: '', forcePathStyle: false }
const GDRIVE_EMPTY = { clientId: '', clientSecret: '', folderId: '' }

function S3Fields({ config, set, secretSaved }) {
  return (
    <>
      <TextField
        label="Endpoint" hint="(empty for AWS)" mono value={config.endpoint} onChange={(v) => set('endpoint', v)}
        placeholder="https://<account>.r2.cloudflarestorage.com"
      />
      <p className="text-xs text-zinc-400 -mt-2">
        MinIO <span className="font-mono">http://minio:9000</span> · B2 <span className="font-mono">https://s3.&lt;region&gt;.backblazeb2.com</span> ·
        Wasabi <span className="font-mono">https://s3.&lt;region&gt;.wasabisys.com</span> · R2 region <span className="font-mono">auto</span>
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <TextField label="Bucket" mono value={config.bucket} onChange={(v) => set('bucket', v)} />
        <TextField label="Region" mono value={config.region} onChange={(v) => set('region', v)} placeholder="us-east-1" />
      </div>
      <TextField label="Prefix" hint="(folder inside the bucket)" mono value={config.prefix} onChange={(v) => set('prefix', v)} placeholder="pg-backups/" />
      <TextField label="Access key ID" mono value={config.accessKeyId} onChange={(v) => set('accessKeyId', v)} />
      <TextField
        label="Secret access key" type="password" mono value={config.secretAccessKey} onChange={(v) => set('secretAccessKey', v)}
        placeholder={secretSaved ? '•••••••• (saved, leave empty to keep)' : ''}
      />
      <Toggle checked={!!config.forcePathStyle} onChange={(v) => set('forcePathStyle', v)} label="Force path-style URLs" hint="Needed for MinIO and most self-hosted S3 servers." />
    </>
  )
}

function GDriveFields({ config, set, secretSaved, redirectUri }) {
  return (
    <>
      <Notice>
        In Google Cloud Console, under APIs &amp; Services, Credentials, create an <strong>OAuth client ID</strong> of type
        <strong> Web application</strong> (enable the Google Drive API first) and add the redirect URI below to
        “Authorized redirect URIs”. After saving, use <strong>Connect Google Drive</strong>.
      </Notice>
      <CopyField label="Authorized redirect URI" value={redirectUri} />
      <TextField label="OAuth client ID" mono value={config.clientId} onChange={(v) => set('clientId', v)} placeholder="1234-abc.apps.googleusercontent.com" />
      <TextField
        label="OAuth client secret" type="password" mono value={config.clientSecret} onChange={(v) => set('clientSecret', v)}
        placeholder={secretSaved ? '•••••••• (saved, leave empty to keep)' : ''}
      />
      <TextField label="Folder ID" hint="(optional, from the folder URL)" mono value={config.folderId} onChange={(v) => set('folderId', v)} />
    </>
  )
}

/**
 * Add / edit a destination.
 * @param {{ destination?: object, type: 's3'|'gdrive', redirectUri: string, onClose: Function, onSave: Function }} props
 */
export default function DestinationForm({ destination, type, redirectUri, onClose, onSave }) {
  const empty = type === 's3' ? S3_EMPTY : GDRIVE_EMPTY
  const [name, setName] = useState(destination?.name || (type === 's3' ? 'S3' : 'Google Drive'))
  const [enabled, setEnabled] = useState(destination?.enabled ?? true)
  const [isDefault, setIsDefault] = useState(destination?.isDefault ?? false)
  const [config, setConfig] = useState({ ...empty, ...destination?.config, secretAccessKey: '', clientSecret: '' })
  const [retention, setRetention] = useState(destination?.retention || { keepLast: null, keepDays: null })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)

  const set = (key, value) => setConfig((c) => ({ ...c, [key]: value }))
  const secretSaved = type === 's3' ? destination?.secrets?.secretAccessKey : destination?.secrets?.clientSecret

  async function submit() {
    setSaving(true)
    setError(null)
    const { accountEmail, refreshToken, ...editable } = config
    try {
      await onSave({ type, name, enabled, isDefault, retention, config: editable })
    } catch (e) {
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }

  const title = `${destination ? 'Edit' : 'Add'} ${type === 's3' ? 'S3-compatible storage' : 'Google Drive'}`
  return (
    <Modal icon={HardDrive} title={title} subtitle="Secrets are stored encrypted and never sent back to the browser."
      size="lg" onClose={onClose}>
      <div className="px-6 py-5 space-y-4">
        <TextField label="Name" value={name} onChange={setName} />
        {type === 's3'
          ? <S3Fields config={config} set={set} secretSaved={secretSaved} />
          : <GDriveFields config={config} set={set} secretSaved={secretSaved} redirectUri={redirectUri} />}
        <div className="pt-1 space-y-3">
          <Toggle checked={isDefault} onChange={setIsDefault} label="Upload every backup here by default" hint="Each backup can still choose its own destinations." />
          <Toggle checked={enabled} onChange={setEnabled} label="Enabled" />
        </div>
        <fieldset>
          <legend className="text-sm text-zinc-300 mb-2">Retention on this destination</legend>
          <RetentionFields value={retention} onChange={setRetention} />
        </fieldset>
        {error && <ErrorAlert message={error} />}
      </div>

      <ModalFooter>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button disabled={saving || !name.trim()} onClick={submit}>{saving ? 'Saving…' : 'Save'}</Button>
      </ModalFooter>
    </Modal>
  )
}
