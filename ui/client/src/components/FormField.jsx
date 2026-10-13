import React from 'react'

export const MIN_PASSWORD_LENGTH = 10

const INPUT_CLASS =
  'w-full bg-zinc-800 border border-zinc-700 focus:border-emerald-500 rounded-lg px-3 py-2 text-sm ' +
  'text-zinc-100 placeholder-zinc-600 outline-hidden transition-colors disabled:opacity-50'

/** Labelled text/password/email input in the app's dark style. */
export function TextField({ id, label, value, onChange, type = 'text', hint, error, mono = false, ...rest }) {
  return (
    <div>
      <label htmlFor={id} className="block text-xs text-zinc-500 mb-1 font-medium uppercase tracking-wider">
        {label}
      </label>
      <input
        id={id}
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={`${INPUT_CLASS} ${mono ? 'font-mono' : ''} ${error ? 'border-red-500/60' : ''}`}
        {...rest}
      />
      {error
        ? <p className="text-xs text-red-400 mt-1">{error}</p>
        : hint && <p className="text-xs text-zinc-500 mt-1">{hint}</p>}
    </div>
  )
}

/** Labelled <select>. `options` is a list of { value, label }. */
export function SelectField({ id, label, value, onChange, options, ...rest }) {
  return (
    <div>
      <label htmlFor={id} className="block text-xs text-zinc-500 mb-1 font-medium uppercase tracking-wider">
        {label}
      </label>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)} className={INPUT_CLASS} {...rest}>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </div>
  )
}

/** Client-side mirror of the server password policy (the server enforces it). */
export function passwordError(password, confirm) {
  if (password && password.length < MIN_PASSWORD_LENGTH) return `At least ${MIN_PASSWORD_LENGTH} characters`
  if (confirm !== undefined && confirm && confirm !== password) return 'Passwords do not match'
  return null
}

/** Small success/error banner used by forms. */
export function FormMessage({ message }) {
  if (!message) return null
  const cls = message.type === 'success'
    ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400'
    : 'bg-red-500/10 border-red-500/20 text-red-400'
  return <p role="status" className={`text-sm border rounded-lg px-3 py-2 ${cls}`}>{message.text}</p>
}
