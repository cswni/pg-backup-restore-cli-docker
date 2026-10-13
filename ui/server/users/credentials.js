const crypto = require('crypto')
const store = require('./store')
const { verifyPassword, verifyDummy } = require('./passwords')
const { createLimiter, limiterKey } = require('./rate-limit')

// Username/password verification shared by the login endpoint and HTTP
// Basic auth, so both are covered by the same brute-force limiters:
//   - username+IP: 5 failures / 15 min (normal typo tolerance)
//   - username alone: 20 failures / 15 min — holds even when the client IP
//     can be spoofed through a trusted proxy hop
//   - IP alone: 50 failures / 15 min — stops spraying many usernames
// Every attempt costs a 32 MB scrypt, so concurrent verifications are capped
// to keep the libuv thread pool available for the rest of the app.

const MAX_CONCURRENT_VERIFICATIONS = 2
const ACCOUNT_LIMIT = { maxFailures: 20 }
const IP_LIMIT = { maxFailures: 50 }

let pairLimiter = createLimiter()
let accountLimiter = createLimiter(ACCOUNT_LIMIT)
let ipLimiter = createLimiter(IP_LIMIT)
let inFlight = 0

// Recently verified credentials (HTTP Basic sends them on every request).
// Keyed by a SHA-256 of username + password and bound to the stored hash,
// so a password change, disable or role change takes effect immediately.
const VERIFIED_TTL_MS = 60 * 1000
const MAX_VERIFIED = 1000
let verified = new Map() // digest → { passwordHash, expiresAt }

const digest = (username, password) =>
  crypto.createHash('sha256').update(JSON.stringify([String(username).toLowerCase(), password])).digest('hex')

function cachedUser(username, password) {
  const d = digest(username, password)
  const hit = verified.get(d)
  if (!hit || hit.expiresAt <= Date.now()) {
    verified.delete(d)
    return null
  }
  const row = store.findForLogin(username)
  return row && !row.disabled && row.password_hash === hit.passwordHash ? row : null
}

function remember(username, password, row) {
  if (verified.size >= MAX_VERIFIED) verified = new Map()
  verified.set(digest(username, password), { passwordHash: row.password_hash, expiresAt: Date.now() + VERIFIED_TTL_MS })
}

const TOO_MANY = 'Too many failed attempts. Try again later.'

function keys(username, ip) {
  return {
    pair: limiterKey(username, ip),
    account: String(username ?? '').toLowerCase(),
    ip: String(ip ?? ''),
  }
}

function blockedFor(k) {
  return Math.max(pairLimiter.retryAfter(k.pair), accountLimiter.retryAfter(k.account), ipLimiter.retryAfter(k.ip))
}

/**
 * Check credentials for a client IP.
 * @returns {Promise<{ ok: true, user: object } | { ok: false, status: number, error: string, retryAfter?: number }>}
 */
async function checkCredentials(username, password, ip) {
  const cached = cachedUser(username, password)
  if (cached) return { ok: true, user: store.toPublicUser(cached) }

  const k = keys(username, ip)
  const retryAfter = blockedFor(k)
  if (retryAfter) return { ok: false, status: 429, error: TOO_MANY, retryAfter }
  if (inFlight >= MAX_CONCURRENT_VERIFICATIONS) {
    return { ok: false, status: 429, error: 'Too many concurrent sign-in attempts. Try again shortly.', retryAfter: 1 }
  }

  inFlight += 1
  let row
  let valid
  try {
    row = store.findForLogin(username)
    valid = row ? await verifyPassword(password, row.password_hash) : await verifyDummy(password)
  } finally {
    inFlight -= 1
  }

  if (!valid || row.disabled) {
    pairLimiter.fail(k.pair)
    accountLimiter.fail(k.account)
    ipLimiter.fail(k.ip)
    return { ok: false, status: 401, error: 'Invalid username or password' }
  }
  // Success clears this client's own counter only; account/IP counters keep
  // protecting against an attacker sharing the same account or address.
  pairLimiter.reset(k.pair)
  remember(username, password, row)
  return { ok: true, user: store.toPublicUser(row) }
}

/** Send a failed checkCredentials() result as JSON (with Retry-After on 429). */
function sendCredentialError(res, result) {
  if (result.retryAfter) res.setHeader('Retry-After', String(result.retryAfter))
  res.status(result.status).json({ error: result.error })
}

/** Test hook: fresh limiters (optionally with custom limits for the username+IP limiter). */
function resetLimiterForTests(opts) {
  pairLimiter = createLimiter(opts)
  accountLimiter = createLimiter(ACCOUNT_LIMIT)
  ipLimiter = createLimiter(IP_LIMIT)
  inFlight = 0
  verified = new Map()
}

module.exports = { checkCredentials, sendCredentialError, resetLimiterForTests }
