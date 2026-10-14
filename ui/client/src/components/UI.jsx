import React from 'react'
export function StatusBadge({ status }) {
  const map = {
    running:  'bg-blue-500/15 text-blue-400 border-blue-500/20',
    success:  'bg-emerald-500/15 text-emerald-400 border-emerald-500/20',
    error:    'bg-red-500/15 text-red-400 border-red-500/20',
  }
  const cls = map[status] || 'bg-zinc-700/30 text-zinc-400 border-zinc-700'
  return (
    <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium border ${cls}`}>
      {status === 'running' && <span className="w-1.5 h-1.5 rounded-full bg-blue-400 pulse-dot" />}
      {status}
    </span>
  )
}

export function Spinner({ size = 'md', label = 'Loading…' }) {
  const s = size === 'sm' ? 'w-4 h-4 border-2' : 'w-8 h-8 border-2'
  return (
    <span role="status" className="inline-flex">
      <span aria-hidden="true" className={`${s} rounded-full border-zinc-700 border-t-emerald-400 animate-spin`} />
      <span className="sr-only">{label}</span>
    </span>
  )
}

/** Product name, shown in the sidebar, the mobile top bar and on the sign-in page. */
export const APP_NAME = 'PG Backup & Restore'

export function Brand({ large = false }) {
  return (
    <div className="flex items-center gap-2.5">
      <span aria-hidden="true" className={large ? 'text-4xl' : 'text-2xl'}>🐘</span>
      <p className={`font-semibold text-zinc-100 leading-tight ${large ? 'text-lg' : 'text-sm'}`}>{APP_NAME}</p>
    </div>
  )
}

export function PageHeader({ title, subtitle, action }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 mb-8">
      <div className="min-w-0">
        <h1 className="text-2xl font-bold text-zinc-100 break-words">{title}</h1>
        {subtitle && <p className="text-sm text-zinc-400 mt-1">{subtitle}</p>}
      </div>
      {action && <div>{action}</div>}
    </div>
  )
}

/**
 * Transient success/error banner. Errors are announced immediately (role
 * "alert"), successes politely (role "status").
 */
export function Toast({ type, message, onDismiss }) {
  const isError = type === 'error'
  const cls = isError
    ? 'bg-red-500/10 border-red-500/20 text-red-400'
    : 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400'
  return (
    <div role={isError ? 'alert' : 'status'} className={`mb-6 flex items-center gap-2 px-4 py-3 rounded-xl text-sm border ${cls}`}>
      <span aria-hidden="true">{isError ? '⚠️' : '✅'}</span>
      <span className="flex-1 min-w-0 break-words">{message}</span>
      {onDismiss && (
        <button type="button" onClick={onDismiss}
          className="min-h-[44px] -my-3 px-2 text-xs underline opacity-80 hover:opacity-100">
          dismiss
        </button>
      )}
    </div>
  )
}

export function Card({ children, className = '' }) {
  return (
    <div className={`bg-zinc-900 border border-zinc-800 rounded-xl p-5 ${className}`}>
      {children}
    </div>
  )
}

export function Button({ children, onClick, variant = 'primary', size = 'md', disabled = false, className = '', ...rest }) {
  const base = 'inline-flex items-center gap-2 font-medium rounded-lg transition-all duration-150 disabled:opacity-40 disabled:cursor-not-allowed'
  const sizes = {
    sm: 'px-3 py-1.5 text-xs',
    md: 'px-4 py-2 text-sm',
    lg: 'px-5 py-2.5 text-sm',
  }
  const variants = {
    primary:   'bg-emerald-500 hover:bg-emerald-400 text-zinc-950 shadow-xs shadow-emerald-900/30',
    secondary: 'bg-zinc-800 hover:bg-zinc-700 text-zinc-200 border border-zinc-700',
    danger:    'bg-red-600 hover:bg-red-700 text-white shadow-xs shadow-red-900/30',
    ghost:     'text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800',
  }
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`${base} ${sizes[size]} ${variants[variant]} ${className}`}
      {...rest}
    >
      {children}
    </button>
  )
}

export const DB_NAME_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_$-]{0,62}$/

/**
 * Free-text database name with suggestions from existing databases,
 * so a new name (e.g. premas_qa) can be typed or an existing one picked.
 */
export function DbNameInput({ id, value, onChange, options = [], placeholder = 'database_name' }) {
  const invalid = value && !DB_NAME_PATTERN.test(value)
  return (
    <>
      <input
        id={id}
        type="text"
        list={`${id}-options`}
        aria-invalid={invalid || undefined}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value.trim())}
        className={`w-full bg-zinc-800 border rounded-lg px-3 py-2 text-sm font-mono text-zinc-100 placeholder-zinc-400 outline-hidden transition-colors ${
          invalid ? 'border-red-500/60 focus:border-red-500' : 'border-zinc-500 focus:border-emerald-500'
        }`}
      />
      <datalist id={`${id}-options`}>
        {options.map((d) => <option key={d} value={d} />)}
      </datalist>
      {invalid && (
        <p className="text-xs text-red-400 mt-1">Use letters, digits, _, $ or - (max 63 chars).</p>
      )}
    </>
  )
}

/** Hint under the "drop target before restore" toggle. */
export function dropTargetHint(db, exists, dropExisting) {
  if (!exists) return 'Target does not exist yet. It will be created.'
  if (dropExisting) return `⚠️ "${db}" will be dropped (all connections terminated) and recreated empty.`
  return `⚠️ "${db}" already exists. The restore will be refused if it has tables. Enable this to replace it.`
}

export function Toggle({ checked, onChange, label, hint, danger = false }) {
  const on = danger ? 'bg-red-500' : 'bg-emerald-500'
  return (
    <label className="flex items-start gap-3 cursor-pointer select-none group">
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={`relative shrink-0 mt-0.5 w-10 h-5 rounded-full transition-colors ${checked ? on : 'bg-zinc-500'}`}
      >
        <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow-sm transition-transform ${checked ? 'translate-x-5' : ''}`} />
      </button>
      <span>
        <span className="block text-sm text-zinc-300 group-hover:text-zinc-100 transition-colors">{label}</span>
        {hint && <span className="block text-xs text-zinc-400 mt-0.5">{hint}</span>}
      </span>
    </label>
  )
}

export function ProgressBar({ percent }) {
  return (
    <div>
      <div className="flex justify-between text-xs text-zinc-400 mb-1">
        <span>{percent < 100 ? 'Uploading…' : 'Upload complete, processing…'}</span>
        <span className="font-mono">{percent}%</span>
      </div>
      <div className="h-2 rounded-full bg-zinc-800 overflow-hidden" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}>
        <div className="h-full bg-emerald-500 transition-[width] duration-200" style={{ width: `${percent}%` }} />
      </div>
    </div>
  )
}

export function EmptyState({ icon, title, description }) {
  return (
    <div className="flex flex-col items-center justify-center py-20 text-center">
      <div aria-hidden="true" className="text-5xl mb-4">{icon}</div>
      <p className="text-zinc-300 font-semibold text-lg">{title}</p>
      <p className="text-zinc-400 text-sm mt-1 max-w-xs">{description}</p>
    </div>
  )
}

export function ErrorAlert({ message, onRetry }) {
  return (
    <div role="alert" className="flex items-start gap-3 bg-red-500/10 border border-red-500/20 rounded-xl p-4 text-sm text-red-400">
      <span aria-hidden="true" className="text-lg leading-none mt-0.5">⚠️</span>
      <div className="flex-1 min-w-0 break-words">
        <p className="font-medium">Error</p>
        <p className="text-red-400/80 mt-0.5">{message}</p>
      </div>
      {onRetry && (
        <button type="button" onClick={onRetry} className="min-h-[44px] -my-3 px-2 text-red-400 hover:text-red-300 underline text-xs">
          Retry
        </button>
      )}
    </div>
  )
}

