import React, { useState } from 'react'

// Small form primitives shared by the storage settings components.

const inputCls = 'w-full bg-zinc-800 border border-zinc-700 focus:border-emerald-500 rounded-lg px-3 py-2 text-sm text-zinc-100 placeholder-zinc-600 outline-hidden transition-colors'

export function Label({ children, hint }) {
  return (
    <label className="block text-xs text-zinc-500 mb-1 font-medium uppercase tracking-wider">
      {children}
      {hint && <span className="ml-1 text-zinc-600 normal-case tracking-normal">{hint}</span>}
    </label>
  )
}

export function TextField({ label, hint, value, onChange, placeholder, type = 'text', mono = false, autoComplete = 'off' }) {
  return (
    <div>
      <Label hint={hint}>{label}</Label>
      <input
        type={type}
        value={value ?? ''}
        placeholder={placeholder}
        autoComplete={autoComplete}
        onChange={(e) => onChange(e.target.value)}
        className={`${inputCls} ${mono ? 'font-mono' : ''}`}
      />
    </div>
  )
}

/** Integer input where empty means "not set" (null). */
export function CountField({ label, hint, value, onChange, placeholder = 'off', max }) {
  return (
    <div>
      <Label hint={hint}>{label}</Label>
      <input
        type="number"
        min={1}
        max={max}
        value={value ?? ''}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value === '' ? null : Math.max(1, Math.floor(Number(e.target.value))))}
        className={`${inputCls} font-mono`}
      />
    </div>
  )
}

/** Read-only value with a copy button (e.g. the OAuth redirect URI). */
export function CopyField({ label, value }) {
  const [copied, setCopied] = useState(false)
  async function copy() {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      setCopied(false)
    }
  }
  return (
    <div>
      <Label>{label}</Label>
      <div className="flex gap-2">
        <input readOnly value={value} onFocus={(e) => e.target.select()} className={`${inputCls} font-mono text-xs text-emerald-300`} />
        <button
          type="button"
          onClick={copy}
          className="shrink-0 px-3 rounded-lg text-xs font-medium bg-zinc-800 border border-zinc-700 text-zinc-300 hover:bg-zinc-700 hover:text-zinc-100 transition-colors"
        >
          {copied ? '✓ Copied' : 'Copy'}
        </button>
      </div>
    </div>
  )
}

export function SectionTitle({ icon, title, subtitle }) {
  return (
    <div className="flex items-start gap-3 mb-4">
      <span className="text-xl leading-none mt-0.5">{icon}</span>
      <div>
        <h2 className="font-semibold text-zinc-100">{title}</h2>
        {subtitle && <p className="text-xs text-zinc-500 mt-0.5">{subtitle}</p>}
      </div>
    </div>
  )
}

export function Notice({ tone = 'info', children }) {
  const tones = {
    info: 'bg-zinc-800/60 border-zinc-700 text-zinc-400',
    warn: 'bg-amber-500/10 border-amber-500/25 text-amber-300',
    error: 'bg-red-500/10 border-red-500/20 text-red-400',
    success: 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400',
  }
  return <div className={`rounded-xl border px-4 py-3 text-xs leading-relaxed ${tones[tone]}`}>{children}</div>
}
