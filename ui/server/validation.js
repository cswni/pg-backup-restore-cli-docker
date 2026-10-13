// Same rule as the shell scripts: names are always quoted in SQL/commands,
// so only a safe character set is accepted.
const DB_NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_$-]{0,62}$/

function isValidDbName(name) {
  return typeof name === 'string' && DB_NAME_RE.test(name)
}

/** Error carrying an HTTP status for route handlers. */
function httpError(status, message) {
  const err = new Error(message)
  err.status = status
  return err
}

module.exports = { DB_NAME_RE, isValidDbName, httpError }
