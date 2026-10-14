const mysqlDocker = require('../drivers/mysql-docker')
const mysqlDirect = require('../drivers/mysql-direct')
const sql = require('./mysql-sql')

// MySQL / MariaDB explorer. Reuses the backup drivers' runners: the client
// runs in the container with the root password from the container's
// environment (Docker), or in this image with the server's credentials in a
// private option file (direct). Neither puts a password on a command line.

const CHARSET_ARG = '--default-character-set=utf8mb4'

/**
 * Session over a driver runner (`runner.capture('client', args)`).
 * @param {{ capture: (tool: string, args: string[]) => Promise<string> }} runner
 * @param {string} database
 */
function createSession(runner, database) {
  const json = (text) => runner.capture('client', ['-N', '-B', '-r', CHARSET_ARG, '-e', sql.readOnly(text), database])
  return {
    async objects() {
      return sql.parseObjects(await json(sql.objectsSql(database)))
    },
    async structure(object) {
      return sql.parseStructure(await json(sql.structureSql(database, object)))
    },
    async rows(object, opts) {
      const { columns } = opts.structure || await this.structure(object)
      return sql.parseRows(await json(sql.rowsSql(database, object, columns, opts)), columns)
    },
    async query(text, limit) {
      const out = await runner.capture('client', ['-B', CHARSET_ARG, '-e', sql.readOnly(sql.consoleSql(text, limit)), database])
      return sql.parseBatch(out)
    },
  }
}

function adapterFor(open) {
  return {
    supportsQuery: true,
    open: (target, database, fn) => open(target, (runner) => fn(createSession(runner, database))),
  }
}

module.exports = {
  dockerAdapter: adapterFor(mysqlDocker._internals.open),
  directAdapter: adapterFor(mysqlDirect._internals.open),
  createSession,
}
