// Small display formatters shared by the monitoring, job and schedule pages.

const OPERATION_LABELS = { export: 'backup' }

/** Display name of a job type; the API calls a backup 'export'. */
export function operationLabel(type) {
  return OPERATION_LABELS[type] || type
}

/** "5m ago" style relative time for a past timestamp (ms). */
export function timeAgo(ms) {
  if (!ms) return 'never'
  const diff = Date.now() - ms
  if (diff < 60000) return 'just now'
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`
  return `${Math.floor(diff / 86400000)}d ago`
}

/** "in 3h" style relative time for a future timestamp (ms). */
export function timeUntil(ms) {
  if (!ms) return 'not scheduled'
  const diff = ms - Date.now()
  if (diff <= 0) return 'due now'
  if (diff < 3600000) return `in ${Math.max(1, Math.round(diff / 60000))}m`
  if (diff < 86400000) return `in ${Math.floor(diff / 3600000)}h ${Math.floor((diff % 3600000) / 60000)}m`
  return `in ${Math.floor(diff / 86400000)}d`
}

/** Duration between two timestamps, e.g. "1m 05s". */
export function formatDuration(start, end) {
  if (!start || !end) return 'n/a'
  const s = Math.max(0, Math.round((end - start) / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`
}

/** Local date + time. */
export function formatDateTime(ms) {
  return ms ? new Date(ms).toLocaleString() : 'unknown'
}

/** Date + time in a given IANA timezone (falls back to local time). */
export function formatInZone(iso, timeZone) {
  try {
    return new Date(iso).toLocaleString(undefined, { timeZone, dateStyle: 'medium', timeStyle: 'short' })
  } catch {
    return new Date(iso).toLocaleString()
  }
}

/** Byte count as B, KB, MB or GB; "unknown" when the size is not known. */
export function formatBytes(bytes) {
  if (bytes == null) return 'unknown'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`
}

/** Whole number with thousands separators, e.g. 12,480. */
export function formatCount(n) {
  return Number(n).toLocaleString()
}
