// In-memory limiter for failed login attempts (per process; resets on
// restart, which is acceptable for a single-instance admin tool).

const DEFAULT_MAX_FAILURES = 5
const DEFAULT_WINDOW_MS = 15 * 60 * 1000
const MAX_TRACKED_KEYS = 10000

/**
 * Create a fixed-window failure limiter.
 * @param {{ maxFailures?: number, windowMs?: number, now?: () => number }} [opts]
 */
function createLimiter({ maxFailures = DEFAULT_MAX_FAILURES, windowMs = DEFAULT_WINDOW_MS, now = Date.now } = {}) {
  let entries = new Map() // key → { count, resetAt }

  const current = (key) => {
    const entry = entries.get(key)
    if (entry && entry.resetAt <= now()) {
      entries.delete(key)
      return null
    }
    return entry ?? null
  }

  const prune = () => {
    const t = now()
    entries = new Map([...entries].filter(([, e]) => e.resetAt > t))
    // Still too many (attack with many keys): drop the oldest windows
    if (entries.size >= MAX_TRACKED_KEYS) {
      entries = new Map([...entries].sort((a, b) => b[1].resetAt - a[1].resetAt).slice(0, MAX_TRACKED_KEYS / 2))
    }
  }

  return {
    /** Seconds until the key may try again, or 0 when not blocked. */
    retryAfter(key) {
      const entry = current(key)
      if (!entry || entry.count < maxFailures) return 0
      return Math.max(1, Math.ceil((entry.resetAt - now()) / 1000))
    },
    fail(key) {
      const entry = current(key)
      if (!entry && entries.size >= MAX_TRACKED_KEYS) prune()
      entries.set(key, entry
        ? { ...entry, count: entry.count + 1 }
        : { count: 1, resetAt: now() + windowMs })
    },
    reset(key) {
      entries.delete(key)
    },
  }
}

/** Limiter key: case-insensitive username + client IP. */
const limiterKey = (username, ip) => `${String(username ?? '').toLowerCase()}|${ip ?? ''}`

module.exports = { createLimiter, limiterKey }
