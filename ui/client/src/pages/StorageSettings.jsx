import React, { useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import { useFetch } from '../hooks/useFetch'
import { api } from '../lib/api'
import { PageHeader, Spinner, ErrorAlert, Button } from '../components/UI'
import { CompressionCard, EncryptionCard } from '../components/storage/CompressionEncryption'
import { RetentionCard } from '../components/storage/RetentionCard'
import DestinationsCard from '../components/storage/DestinationsCard'

const GDRIVE_ERRORS = {
  invalid_state: 'The connect link expired or was already used — try “Connect Google Drive” again.',
  denied: 'Google access was not granted.',
  unknown_destination: 'The destination no longer exists.',
  exchange_failed: 'Google rejected the authorization (check the client ID/secret and the redirect URI). See the server log for details.',
}

/** Banner for the result of the Google OAuth redirect (?gdrive=connected|error). */
function useOAuthResult() {
  const [params, setParams] = useSearchParams()
  const status = params.get('gdrive')
  const dismiss = () => setParams({}, { replace: true })
  if (status === 'connected') return { tone: 'success', msg: 'Google Drive connected.', dismiss }
  if (status === 'error') return { tone: 'error', msg: GDRIVE_ERRORS[params.get('reason')] || 'Google Drive connection failed.', dismiss }
  return null
}

function Toast({ toast, onClose }) {
  const cls = toast.tone === 'error'
    ? 'bg-red-500/10 border-red-500/20 text-red-400'
    : 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400'
  return (
    <div className={`mb-6 flex items-center gap-2 px-4 py-3 rounded-xl text-sm border ${cls}`}>
      <span>{toast.tone === 'error' ? '⚠️' : '✅'}</span>
      <span className="flex-1">{toast.msg}</span>
      {onClose && <button onClick={onClose} className="text-xs underline opacity-70 hover:opacity-100">dismiss</button>}
    </div>
  )
}

export default function StorageSettings() {
  const settingsQ = useFetch(api.storage.settings)
  const destinationsQ = useFetch(api.storage.destinations)
  const [toast, setToast] = useState(null)
  const oauth = useOAuthResult()
  const navigate = useNavigate()

  const notify = (tone, msg) => {
    setToast({ tone, msg })
    setTimeout(() => setToast(null), 5000)
  }

  async function saveSettings(body) {
    try {
      await api.storage.saveSettings(body)
      settingsQ.reload()
      notify('success', 'Settings saved')
    } catch (e) {
      notify('error', e.message)
    }
  }

  async function runRetention() {
    try {
      const { jobId } = await api.storage.runRetention()
      navigate(`/jobs/${jobId}`)
    } catch (e) {
      notify('error', e.message)
    }
  }

  const loading = settingsQ.loading || destinationsQ.loading
  const error = settingsQ.error || destinationsQ.error
  const settings = settingsQ.data

  return (
    <div className="p-8 max-w-4xl">
      <PageHeader
        title="Storage"
        subtitle="Compression, encryption, cloud copies and retention for new backups"
        action={<Button variant="secondary" size="sm" onClick={() => { settingsQ.reload(); destinationsQ.reload() }}>↻ Refresh</Button>}
      />
      {oauth && <Toast toast={oauth} onClose={oauth.dismiss} />}
      {toast && <Toast toast={toast} />}
      {loading && !settings && <div className="flex justify-center py-20"><Spinner /></div>}
      {error && <ErrorAlert message={error} onRetry={() => { settingsQ.reload(); destinationsQ.reload() }} />}

      {settings && destinationsQ.data && (
        <div className="space-y-6">
          <div className="grid lg:grid-cols-2 gap-6 items-start">
            <CompressionCard settings={settings} onSave={saveSettings} />
            <RetentionCard settings={settings} onSave={saveSettings} onRun={runRetention} />
          </div>
          <EncryptionCard settings={settings} onSave={saveSettings} />
          <DestinationsCard
            destinations={destinationsQ.data}
            redirectUri={settings.gdriveRedirectUri}
            onChanged={destinationsQ.reload}
            notify={notify}
          />
        </div>
      )}
    </div>
  )
}
