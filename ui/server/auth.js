const { bootstrapAuth } = require('./users/bootstrap')
const { checkCredentials, sendCredentialError } = require('./users/credentials')
const sessions = require('./users/sessions')

// Authentication contract used by every module:
//   - setupAuth(app) installs authentication on /api (the SPA and its assets
//     are public; the login page is client-side)
//   - authenticated requests carry req.user = { id, username, role, displayName }
//     where role is 'admin' or 'user', plus req.auth = { method, tokenHash? }
//   - requireAdmin guards admin-only routes (settings, servers, users…)
//
// Accepted credentials, in order:
//   1. session cookie `pgui_session` (browser; unsafe methods need the
//      X-Requested-With: pgui header as CSRF protection)
//   2. Authorization: Basic against the users table (curl, scripts, CI)
// 401s are JSON and never carry WWW-Authenticate, so browsers do not pop up
// their native credentials dialog.

const LOG = '[pg-backup-ui]'
const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])
const CSRF_HEADER = 'x-requested-with'
const CSRF_VALUE = 'pgui'

const isUnsafe = (req) => UNSAFE_METHODS.has(req.method)

/** Browsers label cross-site requests; a state change from another site is never legitimate. */
function isCrossSite(req) {
  const site = req.headers['sec-fetch-site']
  return !!site && site !== 'same-origin' && site !== 'none'
}

/**
 * CSRF guard for cookie-authenticated (or pre-auth) browser requests:
 * unsafe methods must carry `X-Requested-With: pgui`, which a cross-site
 * form or simple request cannot set.
 */
function requireCsrfHeader(req, res, next) {
  if (!isUnsafe(req)) return next()
  if (req.headers[CSRF_HEADER] === CSRF_VALUE && !isCrossSite(req)) return next()
  res.status(403).json({ error: 'Missing or invalid X-Requested-With header' })
}

/** Decode `Authorization: Basic …` into { username, password }, or null. */
function parseBasicAuth(header) {
  const [scheme, encoded] = String(header || '').split(' ')
  if (!/^basic$/i.test(scheme || '') || !encoded) return null
  const decoded = Buffer.from(encoded, 'base64').toString('utf8')
  const idx = decoded.indexOf(':')
  if (idx === -1) return null
  return { username: decoded.slice(0, idx), password: decoded.slice(idx + 1) }
}

const toReqUser = (u) => ({ id: u.id, username: u.username, role: u.role, displayName: u.displayName })

function sessionAuth(req, res, next, token) {
  const session = sessions.findSession(token)
  if (!session) return false
  req.user = toReqUser(session.user)
  req.auth = { method: 'session', tokenHash: session.tokenHash }
  if (session.refreshed) sessions.setSessionCookie(req, res, token)
  requireCsrfHeader(req, res, next)
  return true
}

async function basicAuth(req, res, next, creds) {
  // Browsers may still replay Basic credentials cached from older versions:
  // refuse cross-site state changes made with them.
  if (isUnsafe(req) && isCrossSite(req)) return res.status(403).json({ error: 'Cross-site request refused' })
  const result = await checkCredentials(creds.username, creds.password, req.ip)
  if (!result.ok) return sendCredentialError(res, result)
  req.user = toReqUser(result.user)
  req.auth = { method: 'basic' }
  next()
}

/** Middleware: session cookie or Basic auth, else JSON 401. */
async function authenticate(req, res, next) {
  const token = sessions.readCookie(req, sessions.SESSION_COOKIE)
  if (token && sessionAuth(req, res, next, token)) return

  const creds = parseBasicAuth(req.headers.authorization)
  if (creds) return basicAuth(req, res, next, creds)

  if (token) sessions.clearSessionCookie(req, res) // expired or revoked
  res.status(401).json({ error: 'Authentication required' })
}

function anonymousAdmin(req, res, next) {
  req.user = { id: null, username: 'anonymous', role: 'admin', displayName: 'Anonymous' }
  req.auth = { method: 'none' }
  next()
}

/**
 * Install authentication on /api. Bootstraps the first admin and throws
 * (→ FATAL) when no users and no credentials exist; the caller decides
 * whether to exit.
 */
function setupAuth(app) {
  const { disabled } = bootstrapAuth()
  if (disabled) {
    app.use('/api', anonymousAdmin)
    console.warn(`${LOG} WARNING: BASIC_AUTH_DISABLED=true: the UI and API are UNAUTHENTICATED; every request is an admin`)
    return
  }
  app.use('/api', authenticate)
  console.log(`${LOG} Authentication enabled (session login + HTTP Basic for scripts)`)
}

function requireAdmin(req, res, next) {
  if (req.user?.role === 'admin') return next()
  res.status(403).json({ error: 'Admin role required' })
}

/** True when auth is turned off (every request is an anonymous admin). */
const isAuthDisabled = () => process.env.BASIC_AUTH_DISABLED === 'true'

module.exports = { setupAuth, requireAdmin, requireCsrfHeader, parseBasicAuth, isAuthDisabled }
