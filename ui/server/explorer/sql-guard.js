const { httpError } = require('../validation')

// Checks on SQL typed into the console before it reaches a database client.
// The read-only transaction is the real guard; these checks keep the text a
// single statement so it cannot end that transaction and start another one.

const MAX_SQL_LENGTH = 100000
const MYSQL_COMMANDS = ['system', 'source', 'tee', 'notee', 'pager', 'nopager', 'delimiter', 'connect']
const MYSQL_COMMAND_RE = new RegExp(`^(?:${MYSQL_COMMANDS.join('|')})(?:\\s|$)`, 'i')

/**
 * Validate console input and return it without trailing semicolons.
 * Semicolons anywhere else are refused, even inside string literals: telling
 * those apart would need a full SQL lexer per engine and dialect.
 * @param {unknown} sql
 * @param {'postgres'|'mysql'} engine
 * @returns {string}
 */
function checkConsoleSql(sql, engine) {
  if (typeof sql !== 'string' || !sql.trim()) throw httpError(400, 'Enter an SQL statement')
  if (sql.length > MAX_SQL_LENGTH) throw httpError(400, `The statement is longer than ${MAX_SQL_LENGTH} characters`)
  const text = sql.trim()
  if (engine === 'postgres' && text.startsWith('\\')) {
    throw httpError(400, 'psql backslash commands are not available here; write plain SQL')
  }
  if (engine === 'mysql' && isMysqlClientCommand(text)) {
    throw httpError(400, 'mysql client commands are not available here; write plain SQL')
  }
  const body = text.replace(/[\s;]+$/, '')
  if (!body) throw httpError(400, 'Enter an SQL statement')
  if (body.includes(';')) throw httpError(400, 'Run one statement at a time: a semicolon is only allowed at the end')
  if (body.includes('\0')) throw httpError(400, 'The statement contains a NUL character')
  return body
}

/** True when the text starts a mysql client command, or any line starts with a backslash. */
function isMysqlClientCommand(text) {
  if (text.startsWith('!') || MYSQL_COMMAND_RE.test(text)) return true
  return text.split('\n').some((line) => line.trim().startsWith('\\'))
}

module.exports = { checkConsoleSql, isMysqlClientCommand, MAX_SQL_LENGTH }
