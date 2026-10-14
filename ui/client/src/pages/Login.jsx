import React, { useState } from 'react'
import { useAuth } from '../lib/auth'
import { Button, Brand } from '../components/UI'
import { TextField, FormMessage } from '../components/FormField'

function loginErrorText(err) {
  if (err.status === 429) return 'Too many failed attempts. Please wait a few minutes and try again.'
  if (err.status === 401) return 'Invalid username or password.'
  return err.message || 'Sign in failed.'
}

/** Full-screen sign-in form, rendered outside the sidebar Layout. */
export default function Login() {
  const { login } = useAuth()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(null)

  async function handleSubmit(e) {
    e.preventDefault()
    setSubmitting(true)
    setError(null)
    try {
      await login(username.trim(), password)
      // App re-renders with the user and redirects away from /login
    } catch (err) {
      setError(loginErrorText(err))
      setPassword('')
      setSubmitting(false)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-zinc-950 text-zinc-100 p-4">
      <div className="w-full max-w-sm">
        <div className="flex justify-center mb-8">
          <Brand large />
        </div>

        <form
          onSubmit={handleSubmit}
          className="bg-zinc-900 border border-zinc-800 rounded-2xl p-6 space-y-4 shadow-2xl"
        >
          <div>
            <h1 className="text-xl font-bold">Sign in</h1>
            <p className="text-sm text-zinc-400 mt-1">Use the account your administrator gave you.</p>
          </div>
          <TextField
            id="login-username"
            label="Username"
            value={username}
            onChange={setUsername}
            autoComplete="username"
            autoFocus
            required
          />
          <TextField
            id="login-password"
            label="Password"
            type="password"
            value={password}
            onChange={setPassword}
            autoComplete="current-password"
            required
          />
          <FormMessage message={error && { type: 'error', text: error }} />
          <Button className="w-full justify-center" disabled={submitting || !username || !password}>
            {submitting ? 'Signing in…' : 'Sign in'}
          </Button>
        </form>
      </div>
    </div>
  )
}
