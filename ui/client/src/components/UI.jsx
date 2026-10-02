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

export function Spinner({ size = 'md' }) {
  const s = size === 'sm' ? 'w-4 h-4 border-2' : 'w-8 h-8 border-2'
  return (
    <div className={`${s} rounded-full border-zinc-700 border-t-emerald-400 animate-spin`} />
  )
}

export function PageHeader({ title, subtitle, action }) {
  return (
    <div className="flex items-start justify-between mb-8">
      <div>
        <h1 className="text-2xl font-bold text-zinc-100">{title}</h1>
        {subtitle && <p className="text-sm text-zinc-500 mt-1">{subtitle}</p>}
      </div>
      {action && <div>{action}</div>}
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

export function Button({ children, onClick, variant = 'primary', size = 'md', disabled = false, className = '' }) {
  const base = 'inline-flex items-center gap-2 font-medium rounded-lg transition-all duration-150 disabled:opacity-40 disabled:cursor-not-allowed'
  const sizes = {
    sm: 'px-3 py-1.5 text-xs',
    md: 'px-4 py-2 text-sm',
    lg: 'px-5 py-2.5 text-sm',
  }
  const variants = {
    primary:   'bg-emerald-600 hover:bg-emerald-500 text-white shadow-sm shadow-emerald-900/30',
    secondary: 'bg-zinc-800 hover:bg-zinc-700 text-zinc-200 border border-zinc-700',
    danger:    'bg-red-600 hover:bg-red-500 text-white shadow-sm shadow-red-900/30',
    ghost:     'text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800',
  }
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`${base} ${sizes[size]} ${variants[variant]} ${className}`}
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
        type="text"
        list={`${id}-options`}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value.trim())}
        className={`w-full bg-zinc-800 border rounded-lg px-3 py-2 text-sm font-mono text-zinc-100 placeholder-zinc-600 outline-none transition-colors ${
          invalid ? 'border-red-500/60 focus:border-red-500' : 'border-zinc-700 focus:border-emerald-500'
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
  if (!exists) return 'Target does not exist yet — it will be created.'
  if (dropExisting) return `⚠️ "${db}" will be dropped (all connections terminated) and recreated empty.`
  return `⚠️ "${db}" already exists — the restore will be refused if it has tables. Enable this to replace it.`
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
        className={`relative shrink-0 mt-0.5 w-10 h-5 rounded-full transition-colors ${checked ? on : 'bg-zinc-700'}`}
      >
        <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${checked ? 'translate-x-5' : ''}`} />
      </button>
      <span>
        <span className="block text-sm text-zinc-300 group-hover:text-zinc-100 transition-colors">{label}</span>
        {hint && <span className="block text-xs text-zinc-500 mt-0.5">{hint}</span>}
      </span>
    </label>
  )
}

export function ProgressBar({ percent }) {
  return (
    <div>
      <div className="flex justify-between text-xs text-zinc-400 mb-1">
        <span>{percent < 100 ? 'Uploading…' : 'Upload complete — processing…'}</span>
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
      <div className="text-5xl mb-4">{icon}</div>
      <p className="text-zinc-300 font-semibold text-lg">{title}</p>
      <p className="text-zinc-500 text-sm mt-1 max-w-xs">{description}</p>
    </div>
  )
}

export function ErrorAlert({ message, onRetry }) {
  return (
    <div className="flex items-start gap-3 bg-red-500/10 border border-red-500/20 rounded-xl p-4 text-sm text-red-400">
      <span className="text-lg leading-none mt-0.5">⚠️</span>
      <div className="flex-1">
        <p className="font-medium">Error</p>
        <p className="text-red-400/80 mt-0.5">{message}</p>
      </div>
      {onRetry && (
        <button onClick={onRetry} className="text-red-400 hover:text-red-300 underline text-xs">
          Retry
        </button>
      )}
    </div>
  )
}

