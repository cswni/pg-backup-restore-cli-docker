const crypto = require('crypto')

// Authentication contract used by every module:
//   - setupAuth(app) installs authentication before all routes
//   - authenticated requests carry req.user = { id, username, role }
//     where role is 'admin' or 'user'
//   - requireAdmin guards admin-only routes (settings, servers, users…)
//
// Foundation version: HTTP Basic auth with a single admin from env vars.

/**
 * HTTP Basic authentication middleware.
 *
 * Fails closed: BASIC_AUTH_USER and BASIC_AUTH_PASSWORD are required, and
 * the server refuses to start without them. Auth can only be turned off
 * explicitly with BASIC_AUTH_DISABLED=true (e.g. local development), in
 * which case this returns null.
 */
function createBasicAuth({ user, password, disabled, realm = 'PG Backup & Restore' }) {
  if (disabled) return null
  if (!user || !password) {
    throw new Error(
      'BASIC_AUTH_USER and BASIC_AUTH_PASSWORD must be set. ' +
      'Set BASIC_AUTH_DISABLED=true to run without authentication (not recommended).'
    )
  }

  const expected = crypto.createHash('sha256').update(`${user}:${password}`).digest()

  // Compare SHA-256 digests so timingSafeEqual always gets equal-length buffers
  const matches = (given) => {
    const digest = crypto.createHash('sha256').update(given).digest()
    return crypto.timingSafeEqual(digest, expected)
  }

  return (req, res, next) => {
    const header = req.headers.authorization || ''
    const [scheme, encoded] = header.split(' ')
    if (scheme === 'Basic' && encoded && matches(Buffer.from(encoded, 'base64'))) {
      req.user = { id: null, username: user, role: 'admin' }
      return next()
    }
    res.setHeader('WWW-Authenticate', `Basic realm="${realm}", charset="UTF-8"`)
    res.status(401).json({ error: 'Authentication required' })
  }
}

/**
 * Install authentication on the app. Throws when misconfigured; the caller
 * decides whether to exit.
 */
function setupAuth(app) {
  const basicAuth = createBasicAuth({
    user: process.env.BASIC_AUTH_USER,
    password: process.env.BASIC_AUTH_PASSWORD,
    disabled: process.env.BASIC_AUTH_DISABLED === 'true',
  })
  if (basicAuth) {
    app.use(basicAuth)
    console.log(`[pg-backup-ui] HTTP Basic auth enabled for user '${process.env.BASIC_AUTH_USER}'`)
  } else {
    app.use((req, res, next) => {
      req.user = { id: null, username: 'anonymous', role: 'admin' }
      next()
    })
    console.warn('[pg-backup-ui] WARNING: BASIC_AUTH_DISABLED=true — UI is unauthenticated')
  }
}

function requireAdmin(req, res, next) {
  if (req.user?.role === 'admin') return next()
  res.status(403).json({ error: 'Admin role required' })
}

module.exports = { createBasicAuth, setupAuth, requireAdmin }
