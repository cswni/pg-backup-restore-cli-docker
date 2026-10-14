import React, { useState } from 'react'
import { api } from '../lib/api'
import { useAuth } from '../lib/auth'
import { PageHeader, Card, Button } from '../components/UI'
import { TextField, FormMessage, passwordError, MIN_PASSWORD_LENGTH } from '../components/FormField'

function ProfileForm({ user, onSaved }) {
  const [displayName, setDisplayName] = useState(user.displayName || '')
  const [email, setEmail] = useState(user.email || '')
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState(null)

  async function handleSubmit(e) {
    e.preventDefault()
    setSaving(true)
    setMessage(null)
    try {
      const { user: updated } = await api.auth.updateProfile({ displayName, email })
      onSaved(updated)
      setMessage({ type: 'success', text: 'Profile saved.' })
    } catch (err) {
      setMessage({ type: 'error', text: err.message })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card>
      <form onSubmit={handleSubmit} className="space-y-4">
        <h2 className="text-sm font-semibold text-zinc-200">Profile</h2>
        <div className="grid grid-cols-2 gap-4 text-sm">
          <div>
            <p className="text-xs text-zinc-400 uppercase tracking-wider font-medium mb-1">Username</p>
            <p className="font-mono text-zinc-200">{user.username}</p>
          </div>
          <div>
            <p className="text-xs text-zinc-400 uppercase tracking-wider font-medium mb-1">Role</p>
            <p className="text-zinc-200 capitalize">{user.role}</p>
          </div>
        </div>
        <TextField id="profile-name" label="Display name" value={displayName} onChange={setDisplayName} maxLength={100} autoComplete="name" />
        <TextField id="profile-email" label="Email" type="email" value={email} onChange={setEmail} maxLength={254} autoComplete="email" />
        <FormMessage message={message} />
        <Button disabled={saving}>{saving ? 'Saving…' : 'Save profile'}</Button>
      </form>
    </Card>
  )
}

function PasswordForm() {
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState(null)
  const validation = passwordError(next, confirm)
  const canSubmit = current && next && confirm && !validation && !saving

  async function handleSubmit(e) {
    e.preventDefault()
    setSaving(true)
    setMessage(null)
    try {
      await api.auth.changePassword(current, next)
      setCurrent('')
      setNext('')
      setConfirm('')
      setMessage({ type: 'success', text: 'Password changed. Your other sessions were signed out.' })
    } catch (err) {
      setMessage({ type: 'error', text: err.message })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card>
      <form onSubmit={handleSubmit} className="space-y-4">
        <h2 className="text-sm font-semibold text-zinc-200">Change password</h2>
        <TextField id="pw-current" label="Current password" type="password" value={current} onChange={setCurrent} autoComplete="current-password" />
        <TextField
          id="pw-new" label="New password" type="password" value={next} onChange={setNext}
          autoComplete="new-password" hint={`At least ${MIN_PASSWORD_LENGTH} characters.`}
          error={next && next.length < MIN_PASSWORD_LENGTH ? validation : null}
        />
        <TextField
          id="pw-confirm" label="Confirm new password" type="password" value={confirm} onChange={setConfirm}
          autoComplete="new-password" error={confirm && confirm !== next ? 'Passwords do not match' : null}
        />
        <FormMessage message={message} />
        <Button disabled={!canSubmit}>{saving ? 'Changing…' : 'Change password'}</Button>
      </form>
    </Card>
  )
}

export default function Profile() {
  const { user, authDisabled, setUser } = useAuth()

  return (
    <div className="p-4 md:p-8 max-w-2xl">
      <PageHeader title="Profile" subtitle="Your account details and password" />
      {authDisabled ? (
        <Card>
          <p className="text-sm text-zinc-400">
            Authentication is disabled on this server (<code className="font-mono">BASIC_AUTH_DISABLED=true</code>),
            so there is no signed-in account to edit.
          </p>
        </Card>
      ) : (
        <div className="space-y-6">
          <ProfileForm user={user} onSaved={setUser} />
          <PasswordForm />
        </div>
      )}
    </div>
  )
}
