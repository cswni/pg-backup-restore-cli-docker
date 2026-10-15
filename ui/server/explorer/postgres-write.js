const { _internals: { quoteIdent } } = require('../drivers/postgres-direct')
const { httpError } = require('../validation')
const { writable, jsonLines } = require('./postgres-sql')

// UPDATE / DELETE of one row for the PostgreSQL explorer. Column names and
// cast types come from the catalog (structure); values come from the browser
// as JSON and only ever appear inside E'' string literals, which escape
// backslashes themselves, so the text is safe whatever
// standard_conforming_strings is set to.
//
// Values are compared the way the browser received them:
//   - NULL                      `col IS NULL`
//   - json / jsonb columns      `col::jsonb IS NOT DISTINCT FROM '<json>'::jsonb`
//                               (json has no equality operator)
//   - arrays, composite values  `to_jsonb(col) IS NOT DISTINCT FROM '<json>'::jsonb`,
//                               the same conversion the rows query uses
//   - anything else             `col IS NOT DISTINCT FROM '<text>'::<type>`
// Casts use the type without its modifier: an explicit cast to varchar(n)
// would silently cut the value, the assignment raises an error instead.

const JSON_TYPES = new Set(['json', 'jsonb'])

/** E'' literal; NUL cannot be stored in PostgreSQL text. */
function literal(text) {
  if (text.includes('\0')) throw httpError(400, 'Values cannot contain NUL characters')
  return `E'${text.replace(/\\/g, '\\\\').replace(/'/g, "''")}'`
}

const isJsonColumn = (column) => JSON_TYPES.has(column.castType)
const isArrayColumn = (column) => column.castType.endsWith('[]')
const isStructured = (value) => value !== null && typeof value === 'object'

/** Array input syntax (`{"a","b",NULL}`) for a JSON array, nested arrays as sub-arrays. */
function arrayLiteral(items) {
  const element = (item) => {
    if (item === null) return 'NULL'
    if (Array.isArray(item)) return arrayLiteral(item)
    const text = typeof item === 'object' ? JSON.stringify(item) : String(item)
    return `"${text.replace(/[\\"]/g, '\\$&')}"`
  }
  return `{${items.map(element).join(',')}}`
}

/** SQL expression for a new value of `column`. */
function valueSql(column, value) {
  if (value === null) return 'NULL'
  if (isJsonColumn(column)) return `${literal(JSON.stringify(value))}::${column.castType}`
  if (Array.isArray(value) && isArrayColumn(column)) return `${literal(arrayLiteral(value))}::${column.castType}`
  if (isStructured(value)) throw httpError(400, `${column.name} takes text, a number or a boolean, not a JSON ${Array.isArray(value) ? 'array' : 'object'}`)
  return `${literal(String(value))}::${column.castType}`
}

/** Condition matching `column` against the value the browser received. */
function matchSql(column, value) {
  const c = quoteIdent(column.name)
  if (value === null) return `${c} IS NULL`
  if (isJsonColumn(column)) return `${c}::jsonb IS NOT DISTINCT FROM ${literal(JSON.stringify(value))}::jsonb`
  if (isStructured(value)) return `to_jsonb(${c}) IS NOT DISTINCT FROM ${literal(JSON.stringify(value))}::jsonb`
  return `${c} IS NOT DISTINCT FROM ${valueSql(column, value)}`
}

function columnOf(columns, name) {
  const column = columns.find((c) => c.name === name)
  if (!column) throw httpError(400, `No column named ${name}`)
  return column
}

/** WHERE clause: the full key, then every original value. */
function whereSql(columns, { key, original }) {
  return Object.entries({ ...key, ...original })
    .map(([name, value]) => matchSql(columnOf(columns, name), value))
    .join(' AND ')
}

const tableSql = (object) => `${quoteIdent(object.schema)}.${quoteIdent(object.name)}`

/** Prints the number of rows changed (0 or 1) as the only output line. */
function updateSql(object, columns, request) {
  const sets = Object.entries(request.changes)
    .map(([name, value]) => `${quoteIdent(name)} = ${valueSql(columnOf(columns, name), value)}`)
  return writable(`WITH changed AS (UPDATE ${tableSql(object)} SET ${sets.join(', ')} WHERE ${whereSql(columns, request)} RETURNING 1)
SELECT count(*) FROM changed`)
}

function deleteSql(object, columns, request) {
  return writable(`WITH changed AS (DELETE FROM ${tableSql(object)} WHERE ${whereSql(columns, request)} RETURNING 1)
SELECT count(*) FROM changed`)
}

function parseCount(out) {
  const [count] = jsonLines(out).slice(-1)
  if (typeof count !== 'number') throw new Error(`Unexpected psql output: ${out.trim().slice(0, 200)}`)
  return count
}

module.exports = { literal, arrayLiteral, valueSql, matchSql, updateSql, deleteSql, parseCount }
