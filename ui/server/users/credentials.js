const store = require('./store')
const { verifyPassword, verifyDummy } = require('./passwords')
const { createLimiter, limiterKey } = require('./rate-limit')

// Username/password verification shared by the login endpoint and HTTP
// Basic auth, so both are covered by the same brute-force limiter.

let limiter = createLimiter()

/**
 * Check credentials for a client IP.
 * @returns {Promise<{ ok: true, user: object } | { ok: false, status: number, error: string, retryAfter?: number }>}
 */
async function checkCredentials(username, password, ip) {
  const key = limiterKey(username, ip)
  const retryAfter = limiter.retryAfter(key)
  if (retryAfter) {
    return { ok: false, status: 429, error: 'Too many failed attempts. Try again later.', retryAfter }
  }

  const row = store.findForLogin(username)
  const valid = row
    ? await verifyPassword(password, row.password_hash)
    : await verifyDummy(password)

  if (!valid || row.disabled) {
    limiter.fail(key)
    return { ok: false, status: 401, error: 'Invalid username or password' }
  }
  limiter.reset(key)
  return { ok: true, user: store.toPublicUser(row) }
}

/** Send a failed checkCredentials() result as JSON (with Retry-After on 429). */
function sendCredentialError(res, result) {
  if (result.retryAfter) res.setHeader('Retry-After', String(result.retryAfter))
  res.status(result.status).json({ error: result.error })
}

/** Test hook: fresh limiter (optionally with custom limits). */
function resetLimiterForTests(opts) {
  limiter = createLimiter(opts)
}

module.exports = { checkCredentials, sendCredentialError, resetLimiterForTests }
