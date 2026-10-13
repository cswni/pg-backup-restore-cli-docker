import React, { useState } from 'react'
import { Button, Toggle } from '../UI'
import { TextField, SelectField, FormMessage, passwordError, MIN_PASSWORD_LENGTH } from '../FormField'

const ROLE_OPTIONS = [
  { value: 'user', label: 'User — view, back up, restore, upload, download' },
  { value: 'admin', label: 'Admin — everything, incl. users and deleting backups' },
]

/** Modal shell matching the existing Backups dialogs. */
export function Modal({ title, subtitle, icon, onClose, children }) {
  return (
    <div className="fixed inset-0 z-50 flex overflow-y-auto bg-black/70 backdrop-blur-xs p-4" role="dialog" aria-modal="true">
      {/* m-auto centres the dialog and still lets it scroll on short screens */}
      <div className="m-auto bg-zinc-900 border border-zinc-700 rounded-2xl w-full max-w-md shadow-2xl">
        <div className="flex items-center gap-3 px-6 py-5 border-b border-zinc-800">
          <span className="text-2xl">{icon}</span>
          <div>
            <p className="font-semibold text-zinc-100">{title}</p>
            {subtitle && <p className="text-xs text-zinc-500 font-mono mt-0.5">{subtitle}</p>}
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="ml-auto text-zinc-600 hover:text-zinc-300 text-xl leading-none">✕</button>
        </div>
        {children}
      </div>
    </div>
  )
}

/** Plain button that never submits the surrounding form. */
export function CancelButton({ onClick, children = 'Cancel' }) {
  return (
    <button type="button" onClick={onClick} className="px-4 py-2 text-sm font-medium rounded-lg text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 transition-all">
      {children}
    </button>
  )
}

function initialForm(user) {
  return {
    username: user?.username ?? '',
    displayName: user?.displayName ?? '',
    email: user?.email ?? '',
    role: user?.role ?? 'user',
    disabled: user?.disabled ?? false,
    password: '',
  }
}

/** Only the fields the API accepts; an empty password means "unchanged" when editing. */
function toPayload(form, isNew) {
  const { username, password, ...rest } = form
  if (isNew) return { username: username.trim(), password, ...rest }
  return password ? { ...rest, password } : rest
}

/**
 * Create (user = null) or edit a user.
 * @param {{ user: object|null, isSelf: boolean, onSubmit: (payload: object) => Promise<void>, onClose: () => void }} props
 */
export default function UserDialog({ user, isSelf, onSubmit, onClose }) {
  const isNew = !user
  const [form, setForm] = useState(() => initialForm(user))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)
  const set = (key) => (value) => setForm((f) => ({ ...f, [key]: value }))

  const pwError = passwordError(form.password)
  const canSubmit = !saving && !pwError && (!isNew || (form.username.trim() && form.password))

  async function handleSubmit(e) {
    e.preventDefault()
    setSaving(true)
    setError(null)
    try {
      await onSubmit(toPayload(form, isNew))
    } catch (err) {
      setError(err.message)
      setSaving(false)
    }
  }

  return (
    <Modal icon={isNew ? '👤' : '✏️'} title={isNew ? 'New user' : 'Edit user'} subtitle={user?.username} onClose={onClose}>
      <form onSubmit={handleSubmit}>
        <div className="px-6 py-5 space-y-4">
          {isNew && (
            <TextField id="user-username" label="Username" value={form.username} onChange={set('username')}
              mono autoComplete="off" maxLength={64} hint="Letters, digits, . _ @ -" autoFocus />
          )}
          <TextField id="user-name" label="Display name" value={form.displayName} onChange={set('displayName')} maxLength={100} />
          <TextField id="user-email" label="Email" type="email" value={form.email} onChange={set('email')} maxLength={254} />
          <SelectField id="user-role" label="Role" value={form.role} onChange={set('role')} options={ROLE_OPTIONS} />
          <TextField
            id="user-password" label={isNew ? 'Password' : 'Reset password'} type="password"
            value={form.password} onChange={set('password')} autoComplete="new-password"
            placeholder={isNew ? '' : 'Leave empty to keep the current password'}
            hint={`At least ${MIN_PASSWORD_LENGTH} characters.${isNew ? '' : ' Resetting signs the user out everywhere.'}`}
            error={pwError}
          />
          {!isNew && !isSelf && (
            <Toggle danger checked={form.disabled} onChange={set('disabled')} label="Disabled"
              hint="Disabled users cannot sign in; their sessions end immediately." />
          )}
          <FormMessage message={error && { type: 'error', text: error }} />
        </div>
        <div className="flex justify-end gap-2 px-6 py-4 border-t border-zinc-800">
          <CancelButton onClick={onClose} />
          <Button disabled={!canSubmit}>{saving ? 'Saving…' : isNew ? 'Create user' : 'Save changes'}</Button>
        </div>
      </form>
    </Modal>
  )
}
