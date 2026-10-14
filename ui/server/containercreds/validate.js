const { httpError, isValidDbName } = require('../validation')
const { HOST_RE, DB_USER_RE } = require('../connectivity/validate')
const { ENGINES } = require('./store')

// Input rules for saved container credentials. Values travel as environment
// variables and into option files written inside the container, so control
// characters are rejected everywhere.

const DEFAULT_USERNAMES = { postgres: 'postgres', mysql: 'root' }
const DEFAULT_PG_OS_USER = 'postgres'
const DEFAULT_AUTH_SOURCE = 'admin'
// docker exec -u accepts user, uid, user:group or uid:gid
const OS_USER_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,31}(:[A-Za-z0-9_][A-Za-z0-9_.-]{0,31})?$/
// A Unix socket directory for libpq, e.g. /var/run/postgresql
const SOCKET_DIR_RE = /^\/[A-Za-z0-9._/-]{0,254}$/
const CONTROL_RE = /[\x00-\x1f\x7f]/
const MAX_PASSWORD_LENGTH = 1024

function text(value, label) {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') throw httpError(400, `${label} must be text`)
  return value.trim()
}

function username(value, engine) {
  const name = text(value, 'Username') || DEFAULT_USERNAMES[engine] || ''
  if (!name) throw httpError(400, 'Username is required')
  if (!DB_USER_RE.test(name)) throw httpError(400, 'Invalid username')
  return name
}

/** '' or undefined keeps the stored password, null clears it. */
function password(value, existing) {
  if (value === null) return ''
  if (value === undefined || value === '') return existing?.password || ''
  if (typeof value !== 'string') throw httpError(400, 'Password must be text')
  if (value.length > MAX_PASSWORD_LENGTH || CONTROL_RE.test(value)) {
    throw httpError(400, 'Password cannot contain line breaks or control characters')
  }
  return value
}

/** Missing keeps the stored OS user (default postgres); '' means the image's default user. */
function osUser(value, existing) {
  if (value === undefined) return existing?.osUser ?? DEFAULT_PG_OS_USER
  const user = text(value, 'OS user')
  if (user && !OS_USER_RE.test(user)) throw httpError(400, 'Invalid OS user')
  return user
}

function host(value) {
  const h = text(value, 'Host')
  if (!h) return null
  if (!HOST_RE.test(h) && !SOCKET_DIR_RE.test(h)) throw httpError(400, 'Invalid host')
  return h
}

function authSource(value) {
  const db = text(value, 'Auth database') || DEFAULT_AUTH_SOURCE
  if (!isValidDbName(db)) throw httpError(400, 'Invalid auth database')
  return db
}

/**
 * Validate a PUT body into a storable record.
 * @param {object} body
 * @param {object|null} existing  the stored record (with password), if any
 */
function validateCredentialsInput(body, existing) {
  const input = body && typeof body === 'object' ? body : {}
  const engine = input.engine
  if (!ENGINES.includes(engine)) throw httpError(400, 'Choose an engine: postgres, mysql or mongodb')
  const sameEngine = existing?.engine === engine ? existing : null
  const record = {
    engine,
    username: username(input.username, engine),
    password: password(input.password, existing),
    osUser: null,
    host: null,
    authSource: null,
  }
  if (engine === 'postgres') return { ...record, osUser: osUser(input.osUser, sameEngine), host: host(input.host) }
  if (engine === 'mongodb') return { ...record, authSource: authSource(input.authSource) }
  return record
}

module.exports = { validateCredentialsInput, OS_USER_RE }
