const { execEnv } = require('../servers')
const { withConnection } = require('../connectivity/tunnel')
const { capture, toolEnv } = require('../connectivity/process')
const { _internals: { pgEnv } } = require('../drivers/postgres-direct')
const sql = require('./postgres-sql')

// PostgreSQL explorer. psql runs inside the container for Docker servers
// (as the postgres OS user, like drivers/postgres-docker.js) and in this
// image for direct servers, with the password in PGPASSWORD (pgEnv).

const PSQL_TIMEOUT_MS = 30000

/** psql arguments; `header` prints column names (NUL-separated) instead of tuples only. */
function psqlArgs(database, text, { header = false } = {}) {
  return [
    '-X', '-w', '-q', '-v', 'ON_ERROR_STOP=1',
    ...(header ? ['-A', '-z', '-P', 'footer=off'] : ['-t', '-A']),
    '-d', database, '-c', sql.readOnly(text),
  ]
}

/**
 * Session over a `psql(args)` function that resolves with stdout.
 * @param {(args: string[]) => Promise<string>} psql
 * @param {string} database
 */
function createSession(psql, database) {
  const run = (text, opts) => psql(psqlArgs(database, text, opts))
  return {
    async objects() {
      return sql.parseObjects(await run(sql.OBJECTS_SQL))
    },
    async structure(object) {
      return sql.parseStructure(await run(sql.structureSql(object)))
    },
    async rows(object, opts) {
      const { columns } = opts.structure || await this.structure(object)
      return sql.parseRows(await run(sql.rowsSql(object, columns, opts)), columns)
    },
    async query(text, limit) {
      const result = sql.parseConsole(await run(sql.consoleSql(text, limit)))
      if (result.rows.length) return result
      return { columns: sql.parseHeader(await run(sql.consoleHeaderSql(text), { header: true })), rows: [] }
    },
  }
}

const dockerAdapter = {
  supportsQuery: true,
  async open(target, database, fn) {
    const env = { ...process.env, ...(await execEnv(target.server)) }
    const psql = (args) => capture('docker',
      ['exec', '-u', 'postgres', '-e', 'PGCLIENTENCODING=UTF8', target.container, 'psql', ...args],
      { env, timeout: PSQL_TIMEOUT_MS })
    return fn(createSession(psql, database))
  },
}

const directAdapter = {
  supportsQuery: true,
  open(target, database, fn) {
    return withConnection(target.server, (conn) => {
      const env = toolEnv({ ...pgEnv(conn), PGCLIENTENCODING: 'UTF8' })
      return fn(createSession((args) => capture('psql', args, { env, timeout: PSQL_TIMEOUT_MS }), database))
    })
  },
}

module.exports = { dockerAdapter, directAdapter, createSession, psqlArgs }
