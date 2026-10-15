const { quoteIdent } = require('../drivers/mysql-common')
const { httpError } = require('../validation')
const { writable, baseType } = require('./mysql-sql')

// UPDATE / DELETE of one row for the MySQL / MariaDB explorer. Names come
// from the catalog; text travels as `_utf8mb4 X'<hex>'`, so no value can end
// a literal or reach the mysql client's command parser. The introducer keeps
// it a string literal (CONVERT(... USING) would carry its own collation and
// can fail with "Illegal mix of collations" against the column).
//
// Matching uses `<=>` (NULL-safe). Exceptions:
//   - MySQL JSON columns compare with CAST(... AS JSON), the browser got their text
//   - FLOAT / DOUBLE / REAL columns are not compared: the page shows a rounded
//     decimal that never equals the stored binary value
// Numeric text for integer and decimal columns (bigint and decimal arrive as
// strings) is written as a bare number: compared as a string, MySQL would
// convert both sides to double and lose precision above 2^53.

const APPROXIMATE_TYPES = new Set(['float', 'double', 'real'])
const EXACT_NUMERIC_TYPES = new Set(['tinyint', 'smallint', 'mediumint', 'int', 'integer', 'bigint', 'decimal', 'numeric'])
const NUMERIC_TEXT_RE = /^-?\d{1,65}(\.\d{1,30})?$/

function hexText(text) {
  return `_utf8mb4 X'${Buffer.from(text, 'utf8').toString('hex')}'`
}

/** SQL literal for a JSON value; objects and arrays become their JSON text. */
function literal(value, column) {
  if (value === null) return 'NULL'
  if (typeof value === 'string' && column && EXACT_NUMERIC_TYPES.has(baseType(column)) && NUMERIC_TEXT_RE.test(value)) return value
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE'
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw httpError(400, 'Numbers must be finite')
    return String(value)
  }
  if (typeof value === 'object') return hexText(JSON.stringify(value))
  return hexText(String(value))
}

function matchSql(column, value) {
  const c = quoteIdent(column.name)
  if (value !== null && baseType(column) === 'json') return `${c} <=> CAST(${literal(value, column)} AS JSON)`
  return `${c} <=> ${literal(value, column)}`
}

function columnOf(columns, name) {
  const column = columns.find((c) => c.name === name)
  if (!column) throw httpError(400, `No column named ${name}`)
  return column
}

function whereSql(columns, { key, original }) {
  const compared = Object.entries(original).filter(([name]) => !APPROXIMATE_TYPES.has(baseType(columnOf(columns, name))))
  return [...Object.entries(key), ...compared]
    .map(([name, value]) => matchSql(columnOf(columns, name), value))
    .join(' AND ')
}

const tableSql = (database, object) => `${quoteIdent(database)}.${quoteIdent(object.name)}`

/**
 * ROW_COUNT() after UPDATE counts changed rows, not matched ones (0 when the
 * new value equals the old), so the row is locked and counted first: the
 * output is one `1` line per matched row.
 */
function updateSql(database, object, columns, request) {
  const table = tableSql(database, object)
  const where = whereSql(columns, request)
  const sets = Object.entries(request.changes).map(([name, value]) => `${quoteIdent(name)} = ${literal(value, columnOf(columns, name))}`)
  return writable([
    'START TRANSACTION;',
    `SELECT 1 FROM ${table} WHERE ${where} FOR UPDATE;`,
    `UPDATE ${table} SET ${sets.join(', ')} WHERE ${where} LIMIT 1;`,
    'COMMIT;',
  ].join('\n'))
}

/** Output: the number of deleted rows. */
function deleteSql(database, object, columns, request) {
  return writable(`DELETE FROM ${tableSql(database, object)} WHERE ${whereSql(columns, request)} LIMIT 1;\nSELECT ROW_COUNT();`)
}

const outputLines = (out) => out.split('\n').map((l) => l.trim()).filter(Boolean)

function parseMatched(out) {
  return outputLines(out).filter((l) => l === '1').length
}

function parseRowCount(out) {
  const count = Number(outputLines(out).at(-1))
  if (!Number.isInteger(count)) throw new Error(`Unexpected mysql output: ${out.trim().slice(0, 200)}`)
  return count
}

module.exports = { literal, matchSql, updateSql, deleteSql, parseMatched, parseRowCount }
