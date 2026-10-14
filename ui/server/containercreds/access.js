const { resolveFor } = require('./store')

// How saved credentials reach a client running inside a container. Values go
// into the environment of the local `docker` process only and are forwarded
// with `docker exec -e NAME` (no value), so they never appear on a command line.

const DEFAULT_PG_OS_USER = 'postgres'

/** Only the entries with a non-empty value. */
function nonEmpty(vars) {
  return Object.fromEntries(Object.entries(vars).filter(([, v]) => typeof v === 'string' && v !== ''))
}

/** `-e NAME` pairs for docker exec. */
function envFlags(env) {
  return Object.keys(env).flatMap((name) => ['-e', name])
}

/**
 * PostgreSQL in a container: the OS user for `docker exec -u` (null = the
 * image's default user) and the libpq variables to forward.
 * @returns {{ osUser: string|null, env: object }}
 */
function postgresAccess(target) {
  const creds = resolveFor(target.server, target.container, 'postgres')
  if (!creds) return { osUser: DEFAULT_PG_OS_USER, env: {} }
  return {
    osUser: creds.osUser === null || creds.osUser === undefined ? DEFAULT_PG_OS_USER : (creds.osUser || null),
    env: nonEmpty({ PGUSER: creds.username, PGPASSWORD: creds.password, PGHOST: creds.host }),
  }
}

/** docker exec options (before the container name) for a postgresAccess() result. */
function postgresExecOptions(access) {
  return [...(access.osUser ? ['-u', access.osUser] : []), ...envFlags(access.env)]
}

/**
 * Environment for the pg-*.sh scripts. Every variable is set explicitly so
 * values from the server's own environment never leak into the container.
 */
function postgresScriptEnv(access) {
  return { PG_EXEC_USER: access.osUser || '', PGUSER: '', PGPASSWORD: '', PGHOST: '', ...access.env }
}

/**
 * MySQL / MongoDB: the PGUI_DB_* variables their container wrappers prefer
 * over the container's own environment. Empty when nothing is saved.
 * @param {'mysql'|'mongodb'} engine
 * @returns {object}
 */
function clientAccessEnv(target, engine) {
  const creds = resolveFor(target.server, target.container, engine)
  if (!creds) return {}
  return nonEmpty({
    PGUI_DB_USER: creds.username,
    PGUI_DB_PASSWORD: creds.password,
    PGUI_DB_AUTHSOURCE: engine === 'mongodb' ? creds.authSource : null,
  })
}

module.exports = { postgresAccess, postgresExecOptions, postgresScriptEnv, clientAccessEnv, envFlags, DEFAULT_PG_OS_USER }
