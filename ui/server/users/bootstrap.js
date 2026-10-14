const store = require('./store')
const { hashPasswordSync, passwordPolicyError } = require('./passwords')
const { isValidUsername } = require('./validate')

// First-run admin creation (fail closed).
//
// The env credentials only SEED the first admin when the users table is
// empty. Once users exist they are ignored, so changing BASIC_AUTH_PASSWORD
// later never silently overwrites a password that was changed in the UI.

const LOG = '[pg-backup-ui]'

/** Initial admin credentials from env (ADMIN_* take precedence over BASIC_AUTH_*). */
function envCredentials(env) {
  const user = env.ADMIN_USER || env.BASIC_AUTH_USER
  const password = env.ADMIN_PASSWORD || env.BASIC_AUTH_PASSWORD
  return { user, password }
}

/**
 * Make sure an admin can log in. Throws (→ FATAL at startup) when there are
 * no users and no credentials, unless auth is explicitly disabled.
 * @returns {{ disabled: boolean, created: boolean }}
 */
function bootstrapAuth(env = process.env, log = console) {
  store.initSchema()
  const disabled = env.BASIC_AUTH_DISABLED === 'true'
  const { user, password } = envCredentials(env)

  if (store.countUsers() > 0) {
    if (user || password) {
      log.log(`${LOG} Users already exist; BASIC_AUTH_*/ADMIN_* only seed the first admin and are ignored`)
    }
    return { disabled, created: false }
  }

  if (!user || !password) {
    if (disabled) return { disabled, created: false }
    throw new Error(
      'No users exist and no initial admin credentials were given. Set BASIC_AUTH_USER and ' +
      'BASIC_AUTH_PASSWORD (or ADMIN_USER and ADMIN_PASSWORD) to create the first admin. ' +
      'Set BASIC_AUTH_DISABLED=true to run without authentication (not recommended).'
    )
  }
  if (!isValidUsername(user)) {
    throw new Error(`Invalid initial admin username '${user}': use letters, digits, ".", "_", "@" or "-"`)
  }
  if (passwordPolicyError(password)) {
    log.warn(`${LOG} WARNING: the initial admin password is shorter than the policy minimum; change it on the Profile page`)
  }

  store.createUser({ username: user, displayName: user, passwordHash: hashPasswordSync(password), role: 'admin' })
  log.log(`${LOG} Created initial admin user '${user}'`)
  return { disabled, created: true }
}

module.exports = { bootstrapAuth, envCredentials }
