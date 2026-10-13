const { httpError } = require('../validation')
const { ROLES } = require('./store')
const { passwordPolicyError } = require('./passwords')

// Input validation for the users API. Each helper throws a 400 httpError
// and returns the normalised value.

const USERNAME_RE = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,63}$/
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const MAX_DISPLAY_NAME = 100
const MAX_EMAIL = 254

function isValidUsername(username) {
  return typeof username === 'string' && USERNAME_RE.test(username)
}

function username(value) {
  if (!isValidUsername(value)) {
    throw httpError(400, 'Username must be 1-64 characters: letters, digits, ".", "_", "@" or "-"')
  }
  return value
}

function displayName(value) {
  if (value === undefined) return undefined
  if (value === null) return ''
  if (typeof value !== 'string') throw httpError(400, 'displayName must be a string')
  const trimmed = value.trim()
  if (trimmed.length > MAX_DISPLAY_NAME) throw httpError(400, `displayName must be at most ${MAX_DISPLAY_NAME} characters`)
  return trimmed
}

function email(value) {
  if (value === undefined) return undefined
  if (value === null) return ''
  if (typeof value !== 'string') throw httpError(400, 'email must be a string')
  const trimmed = value.trim()
  if (trimmed && (trimmed.length > MAX_EMAIL || !EMAIL_RE.test(trimmed))) throw httpError(400, 'Invalid email address')
  return trimmed
}

function role(value) {
  if (value === undefined) return undefined
  if (!ROLES.includes(value)) throw httpError(400, `role must be one of: ${ROLES.join(', ')}`)
  return value
}

function disabled(value) {
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') throw httpError(400, 'disabled must be a boolean')
  return value
}

function password(value, field = 'password') {
  const error = passwordPolicyError(value)
  if (error) throw httpError(400, error.replace(/^Password/, field === 'password' ? 'Password' : field))
  return value
}

/** Plain object body or a 400. */
function body(req) {
  const b = req.body
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw httpError(400, 'JSON body required')
  return b
}

module.exports = { isValidUsername, username, displayName, email, role, disabled, password, body }
