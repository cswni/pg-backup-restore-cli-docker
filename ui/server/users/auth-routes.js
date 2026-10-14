const express = require('express')
const { requireCsrfHeader, isAuthDisabled } = require('../auth')
const { httpError } = require('../validation')
const { handle } = require('../routes/util')
const store = require('./store')
const sessions = require('./sessions')
const validate = require('./validate')
const { hashPassword } = require('./passwords')
const { checkCredentials, sendCredentialError } = require('./credentials')

// /api/auth/*: login/logout are public (mounted before auth); the "me"
// endpoints need an authenticated user.

const publicRouter = express.Router()
const router = express.Router()

const credentialString = (value, name) => {
  if (typeof value !== 'string' || !value) throw httpError(400, `${name} is required`)
  return value
}

publicRouter.post('/auth/login', requireCsrfHeader, handle(async (req, res) => {
  if (isAuthDisabled()) throw httpError(400, 'Authentication is disabled on this server')
  const body = validate.body(req)
  const username = credentialString(body.username, 'username')
  const password = credentialString(body.password, 'password')

  const result = await checkCredentials(username, password, req.ip)
  if (!result.ok) return sendCredentialError(res, result)

  // Never reuse a session id the browser already had (session fixation)
  sessions.deleteSession(sessions.readCookie(req, sessions.SESSION_COOKIE))
  const { token } = sessions.createSession(result.user.id, { ip: req.ip, userAgent: req.headers['user-agent'] })
  store.touchLastLogin(result.user.id)
  sessions.setSessionCookie(req, res, token)
  res.json({ user: store.getUser(result.user.id) })
}))

publicRouter.post('/auth/logout', requireCsrfHeader, (req, res) => {
  sessions.deleteSession(sessions.readCookie(req, sessions.SESSION_COOKIE))
  sessions.clearSessionCookie(req, res)
  res.json({ ok: true })
})

/** The signed-in user's row, or 400 for the anonymous admin (auth disabled). */
function currentUser(req) {
  if (req.user?.id == null) throw httpError(400, 'Not available while authentication is disabled')
  const user = store.getUser(req.user.id)
  if (!user) throw httpError(401, 'Authentication required')
  return user
}

router.get('/auth/me', handle(async (req, res) => {
  const user = req.user?.id == null ? { ...req.user, email: '' } : currentUser(req)
  res.json({ user, authMethod: req.auth?.method ?? 'none', authDisabled: isAuthDisabled() })
}))

router.put('/auth/me', handle(async (req, res) => {
  const body = validate.body(req)
  const user = currentUser(req)
  const updated = store.updateUser(user.id, {
    displayName: validate.displayName(body.displayName),
    email: validate.email(body.email),
  })
  res.json({ user: updated })
}))

router.put('/auth/me/password', handle(async (req, res) => {
  const body = validate.body(req)
  const user = currentUser(req)
  const currentPassword = credentialString(body.currentPassword, 'currentPassword')
  const newPassword = validate.password(body.newPassword, 'newPassword')

  const check = await checkCredentials(user.username, currentPassword, req.ip)
  if (!check.ok) {
    // A wrong current password must not look like an expired session
    return sendCredentialError(res, check.status === 401 ? { status: 400, error: 'Current password is incorrect' } : check)
  }
  store.updateUser(user.id, { passwordHash: await hashPassword(newPassword) })
  sessions.revokeUserSessions(user.id, req.auth?.tokenHash ?? null)
  res.json({ ok: true })
}))

module.exports = { publicRouter, router }
