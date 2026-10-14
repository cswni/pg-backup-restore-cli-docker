const { quoteIdent, quoteLiteral } = require('../drivers/mysql-common')
const { slotCell, jsonCell, MAX_TEXT, BINARY_PREVIEW_BYTES } = require('./cells')

// SQL text and output parsing for the MySQL / MariaDB explorer. Browsing
// queries select one JSON_ARRAY per row and run with `-N -B -r`, so each
// output line is one JSON document. Console results come back as escaped
// tab-separated text (`-B`) because their columns are not known up front.

const STATEMENT_TIMEOUT_S = 10

/**
 * Read-only transaction with a statement timeout. MySQL names the setting
 * max_execution_time (ms), MariaDB max_statement_time (s); a prepared SET
 * picks the right one without an extra round trip.
 */
function readOnly(sql) {
  return [
    'SET SESSION TRANSACTION READ ONLY;',
    `SET @pgui_timeout = IF(VERSION() LIKE '%MariaDB%', 'SET SESSION max_statement_time = ${STATEMENT_TIMEOUT_S}', 'SET SESSION max_execution_time = ${STATEMENT_TIMEOUT_S * 1000}');`,
    'PREPARE pgui_timeout FROM @pgui_timeout;',
    'EXECUTE pgui_timeout;',
    'DEALLOCATE PREPARE pgui_timeout;',
    'START TRANSACTION READ ONLY;',
    sql,
  ].join('\n')
}

function objectsSql(database) {
  return `SELECT JSON_ARRAY(TABLE_NAME, TABLE_TYPE, TABLE_ROWS, DATA_LENGTH + INDEX_LENGTH)
  FROM information_schema.TABLES WHERE TABLE_SCHEMA = ${quoteLiteral(database)} ORDER BY TABLE_NAME;`
}

/** Non-empty output lines parsed as JSON. */
function jsonLines(out) {
  return out.split('\n').map((l) => l.replace(/\r$/, '')).filter(Boolean).map((l) => JSON.parse(l))
}

function parseObjects(out) {
  return jsonLines(out).map(([name, tableType, rows, sizeBytes]) => {
    const isView = tableType === 'VIEW'
    return { schema: null, name, type: isView ? 'view' : 'table', rows: isView ? null : rows ?? null, sizeBytes: isView ? null : sizeBytes ?? null }
  })
}

/** Columns and indexes in one call; the first array item tells the result sets apart. */
function structureSql(database, object) {
  const where = `TABLE_SCHEMA = ${quoteLiteral(database)} AND TABLE_NAME = ${quoteLiteral(object.name)}`
  return `SELECT JSON_ARRAY('c', COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE = 'YES', COLUMN_DEFAULT, COLUMN_KEY = 'PRI')
  FROM information_schema.COLUMNS WHERE ${where} ORDER BY ORDINAL_POSITION;
SELECT JSON_ARRAY('i', INDEX_NAME, NON_UNIQUE = 0, COLUMN_NAME)
  FROM information_schema.STATISTICS WHERE ${where} ORDER BY INDEX_NAME, SEQ_IN_INDEX;`
}

function parseStructure(out) {
  const columns = []
  const indexes = new Map()
  for (const [tag, ...fields] of jsonLines(out)) {
    if (tag === 'c') {
      const [name, type, nullable, def, primaryKey] = fields
      columns.push({ name, type, nullable: Boolean(nullable), default: def ?? null, primaryKey: Boolean(primaryKey) })
    } else if (tag === 'i') {
      const [name, unique, column] = fields
      const index = indexes.get(name) || { name, columns: [], unique: Boolean(unique) }
      indexes.set(name, { ...index, columns: [...index.columns, column ?? '(expression)'] })
    }
  }
  return { columns, indexes: [...indexes.values()] }
}

const BINARY_TYPES = new Set(['binary', 'varbinary', 'tinyblob', 'blob', 'mediumblob', 'longblob', 'geometry', 'point',
  'linestring', 'polygon', 'multipoint', 'multilinestring', 'multipolygon', 'geometrycollection'])
const PLAIN_TYPES = new Set(['tinyint', 'smallint', 'mediumint', 'int', 'integer', 'bigint', 'float', 'double', 'real',
  'decimal', 'numeric', 'year', 'time', 'bit'])
const DATETIME_TYPES = new Set(['date', 'datetime', 'timestamp'])

/** 'binary' | 'datetime' | 'plain' | 'text' from a COLUMN_TYPE such as `varchar(20)`. */
function columnKind(column) {
  const base = String(column.type).toLowerCase().split(/[\s(]/)[0]
  if (BINARY_TYPES.has(base)) return 'binary'
  if (DATETIME_TYPES.has(base)) return 'datetime'
  if (PLAIN_TYPES.has(base)) return 'plain'
  return 'text'
}

/** Two slots per column, [length, value]; see cells.slotCell. */
function columnSlots(column) {
  const c = quoteIdent(column.name)
  const kind = columnKind(column)
  if (kind === 'binary') return [`LENGTH(${c})`, `HEX(LEFT(${c}, ${BINARY_PREVIEW_BYTES}))`]
  if (kind === 'text') return [`CHAR_LENGTH(${c})`, `LEFT(${c}, ${MAX_TEXT})`]
  if (String(column.type).toLowerCase().startsWith('bit')) return ['NULL', `${c} + 0`]
  return ['NULL', c]
}

function orderBy(columns, sort, dir) {
  if (sort) return ` ORDER BY ${quoteIdent(sort)} ${dir === 'desc' ? 'DESC' : 'ASC'}`
  const pk = columns.filter((c) => c.primaryKey).map((c) => `${quoteIdent(c.name)} ASC`)
  return pk.length ? ` ORDER BY ${pk.join(', ')}` : ''
}

/** Page query; `sort` is a known column, limit and offset validated integers. */
function rowsSql(database, object, columns, { limit, offset, sort, dir }) {
  const slots = columns.flatMap(columnSlots)
  return `SELECT JSON_ARRAY(${slots.join(', ')}) FROM ${quoteIdent(database)}.${quoteIdent(object.name)}`
    + `${orderBy(columns, sort, dir)} LIMIT ${Number(limit) + 1} OFFSET ${Number(offset)};`
}

function parseRows(out, columns) {
  const kinds = columns.map(columnKind)
  return {
    columns: columns.map((c) => c.name),
    rows: jsonLines(out).map((slots) => kinds.map((kind, i) => slotCell(kind, slots[2 * i], slots[2 * i + 1]))),
  }
}

/**
 * Console statement. The text travels as a hex literal and runs through
 * PREPARE / EXECUTE: the mysql client never parses it (so no client
 * commands), and PREPARE accepts exactly one statement. sql_select_limit
 * caps the rows the server sends.
 */
function consoleSql(sql, limit) {
  const hex = Buffer.from(sql, 'utf8').toString('hex')
  return [
    `SET SESSION sql_select_limit = ${Number(limit) + 1};`,
    `SET @pgui_sql = CONVERT(X'${hex}' USING utf8mb4);`,
    'PREPARE pgui_stmt FROM @pgui_sql;',
    'EXECUTE pgui_stmt;',
  ].join('\n')
}

/** One `mysql -B` field: \\ \t \n \0 escapes; NULL is printed as the word NULL. */
function batchField(field) {
  if (field === 'NULL') return null
  return field.replace(/\\(.)/g, (m, ch) => ({ n: '\n', t: '\t', 0: '\0', '\\': '\\' })[ch] ?? m)
}

/** `mysql -B` output with a header line into columns and cells. */
function parseBatch(out) {
  const lines = out.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  if (!lines.length) return { columns: [], rows: [] }
  const [header, ...rest] = lines
  return {
    columns: header.split('\t').map((f) => batchField(f) ?? 'NULL'),
    rows: rest.map((line) => line.split('\t').map((f) => jsonCell(batchField(f)))),
  }
}

module.exports = {
  STATEMENT_TIMEOUT_S, readOnly, objectsSql, parseObjects, structureSql, parseStructure, columnKind,
  rowsSql, parseRows, consoleSql, batchField, parseBatch,
}
