import React, { useState } from 'react'
import { Button, Toggle } from '../UI'
import Modal, { ModalFooter, CancelButton } from '../Modal'
import { TextField, SelectField, FormMessage, passwordError, MIN_PASSWORD_LENGTH } from '../FormField'

const ROLE_OPTIONS = [
  { value: 'user', label: 'User: view, back up, upload, download and run schedules' },
  { value: 'admin', label: 'Admin: everything, including restores, creating and dropping databases, users and deleting backups' },
]

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
    <Modal icon={isNew ? '👤' : '✏️'} title={isNew ? 'New user' : 'Edit user'} subtitle={user?.username} subtitleClassName="font-mono" onClose={onClose}>
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
        <ModalFooter>
          <CancelButton onClick={onClose} />
          <Button type="submit" disabled={!canSubmit}>{saving ? 'Saving…' : isNew ? 'Create user' : 'Save changes'}</Button>
        </ModalFooter>
      </form>
    </Modal>
  )
}
