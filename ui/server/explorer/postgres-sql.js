const { _internals: { quoteIdent, quoteLiteral } } = require('../drivers/postgres-direct')
const { slotCell, jsonCell, MAX_TEXT, BINARY_PREVIEW_BYTES } = require('./cells')

// SQL text and output parsing for the PostgreSQL explorer. Every query runs
// through psql as `BEGIN READ ONLY; SET LOCAL statement_timeout; <query>`,
// prints one jsonb value per row (`psql -tA`), and jsonb text never contains
// a raw newline, so each output line is one JSON document.

const STATEMENT_TIMEOUT = '10s'
// Alias of the console subquery; unusual so it does not clash with a user column.
const CONSOLE_ALIAS = 'pgui_explorer_row'

/** Run `sql` in a read-only transaction with a statement timeout. */
function readOnly(sql) {
  return `BEGIN READ ONLY;\nSET LOCAL statement_timeout = '${STATEMENT_TIMEOUT}';\n${sql}`
}

/** Row edits: no read-only transaction; psql -c runs both statements in one implicit transaction. */
function writable(sql) {
  return `SET statement_timeout = '${STATEMENT_TIMEOUT}';\n${sql}`
}

const OBJECTS_SQL = `SELECT jsonb_build_array(n.nspname, c.relname, c.relkind,
    CASE WHEN c.relkind IN ('r', 'p', 'm') AND c.reltuples >= 0 THEN c.reltuples::bigint END,
    CASE WHEN c.relkind IN ('r', 'p', 'm') THEN pg_total_relation_size(c.oid) END)
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f')
    AND n.nspname NOT IN ('pg_catalog', 'information_schema')
    AND n.nspname NOT LIKE 'pg\\_toast%' AND n.nspname NOT LIKE 'pg\\_temp\\_%'
  ORDER BY n.nspname, c.relname`

/** Non-empty output lines parsed as JSON. */
function jsonLines(out) {
  return out.split('\n').map((l) => l.replace(/\r$/, '')).filter(Boolean).map((l) => JSON.parse(l))
}

function parseObjects(out) {
  return jsonLines(out).map(([schema, name, relkind, rows, sizeBytes]) => ({
    schema,
    name,
    type: relkind === 'v' || relkind === 'm' ? 'view' : 'table',
    rows: rows ?? null,
    sizeBytes: sizeBytes ?? null,
  }))
}

/** `schema.name` as a regclass literal; names come from the catalog listing. */
function regclass(object) {
  return `${quoteLiteral(`${quoteIdent(object.schema)}.${quoteIdent(object.name)}`)}::regclass`
}

/**
 * Columns (with the cast type, format_type without typmod, and whether the
 * column is generated or identity ALWAYS), indexes and the relkind.
 * information_schema keeps this working on servers older than PostgreSQL 12.
 */
function structureSql(object) {
  const rel = regclass(object)
  return `SELECT jsonb_build_object(
  'relkind', (SELECT relkind FROM pg_class WHERE oid = ${rel}),
  'columns', (SELECT coalesce(jsonb_agg(jsonb_build_array(a.attname, format_type(a.atttypid, a.atttypmod),
        NOT a.attnotnull, pg_get_expr(d.adbin, d.adrelid), coalesce(a.attnum = ANY (pk.indkey), false),
        format_type(a.atttypid, NULL), coalesce(isc.is_generated = 'ALWAYS' OR isc.identity_generation = 'ALWAYS', false)) ORDER BY a.attnum), '[]'::jsonb)
    FROM pg_attribute a
    LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
    LEFT JOIN pg_index pk ON pk.indrelid = a.attrelid AND pk.indisprimary
    LEFT JOIN information_schema.columns isc ON isc.table_schema = ${quoteLiteral(object.schema)}
      AND isc.table_name = ${quoteLiteral(object.name)} AND isc.column_name = a.attname
    WHERE a.attrelid = ${rel} AND a.attnum > 0 AND NOT a.attisdropped),
  'indexes', (SELECT coalesce(jsonb_agg(jsonb_build_array(ic.relname, i.indisunique,
        (SELECT jsonb_agg(coalesce(ia.attname, pg_get_indexdef(i.indexrelid, k.n::int, true)) ORDER BY k.n)
          FROM unnest(i.indkey) WITH ORDINALITY AS k(attnum, n)
          LEFT JOIN pg_attribute ia ON ia.attrelid = i.indrelid AND ia.attnum = k.attnum AND k.attnum > 0)) ORDER BY ic.relname), '[]'::jsonb)
    FROM pg_index i JOIN pg_class ic ON ic.oid = i.indexrelid
    WHERE i.indrelid = ${rel}))`
}

/**
 * Internal structure: public column fields plus `editable` (false for key,
 * bytea, array and generated/identity ALWAYS columns) and `castType` for row edits.
 */
function parseStructure(out) {
  const [doc] = jsonLines(out)
  if (!doc) throw new Error('psql returned no structure')
  return {
    columns: doc.columns.map(([name, type, nullable, def, primaryKey, castType, generated]) => ({
      name, type, nullable, default: def ?? null, primaryKey,
      editable: !primaryKey && !generated && type !== 'bytea' && !type.endsWith('[]'),
      castType: castType || type,
    })),
    indexes: doc.indexes.map(([name, unique, columns]) => ({ name, columns: columns || [], unique })),
    readOnlyReason: doc.relkind === 'f' ? 'Foreign tables are read-only here.' : null,
  }
}

function columnKind(column) {
  return column.type === 'bytea' ? 'binary' : 'text'
}

const EXACT_NUMBER_RE = /^(bigint|numeric)(\(|$)/

/**
 * Two slots per column, [length, value], shaped into cells by slotCell.
 * Values longer than MAX_TEXT as text are cut on the server, so a page never
 * carries a whole large document.
 */
function columnSlots(column) {
  const c = quoteIdent(column.name)
  if (columnKind(column) === 'binary') {
    return [`octet_length(${c})`, `encode(substring(${c} FROM 1 FOR ${BINARY_PREVIEW_BYTES}), 'hex')`]
  }
  // bigint and numeric as text: JSON numbers lose precision above 2^53 in the browser
  const value = EXACT_NUMBER_RE.test(column.type) ? `${c}::text` : c
  return [
    `length(${c}::text)`,
    `CASE WHEN length(${c}::text) <= ${MAX_TEXT} THEN to_jsonb(${value}) ELSE to_jsonb(left(${c}::text, ${MAX_TEXT})) END`,
  ]
}

/** ORDER BY clause: the chosen column, else the primary key, else none. */
function orderBy(columns, sort, dir) {
  if (sort) return ` ORDER BY ${quoteIdent(sort)} ${dir === 'desc' ? 'DESC' : 'ASC'}`
  const pk = columns.filter((c) => c.primaryKey).map((c) => `${quoteIdent(c.name)} ASC`)
  return pk.length ? ` ORDER BY ${pk.join(', ')}` : ''
}

/**
 * Page query. `sort` must already be a column of `columns`; limit and offset
 * are validated integers. ARRAY[...] instead of jsonb_build_array because
 * functions take at most 100 arguments.
 */
function rowsSql(object, columns, { limit, offset, sort, dir }) {
  const slots = columns.flatMap(columnSlots).map((s) => `to_jsonb(${s})`)
  return `SELECT to_jsonb(ARRAY[${slots.join(', ')}]::jsonb[]) FROM ${quoteIdent(object.schema)}.${quoteIdent(object.name)}`
    + `${orderBy(columns, sort, dir)} LIMIT ${Number(limit) + 1} OFFSET ${Number(offset)}`
}

function parseRows(out, columns) {
  const kinds = columns.map(columnKind)
  return {
    columns: columns.map((c) => c.name),
    rows: jsonLines(out).map((slots) => kinds.map((kind, i) => slotCell(kind, slots[2 * i], slots[2 * i + 1]))),
  }
}

/**
 * Console query: the user's statement becomes a subquery, so only queries
 * (SELECT, WITH, VALUES, TABLE) are accepted, and each row is turned into
 * [column, value] pairs with json_each, which keeps column order and
 * duplicate names. The newline before the closing parenthesis ends a
 * trailing `--` comment. `sql` comes from checkConsoleSql (no semicolons).
 */
function consoleSql(sql, limit) {
  return `SELECT (SELECT jsonb_agg(jsonb_build_array(e.key, e.value) ORDER BY e.n)
    FROM json_each(row_to_json(${CONSOLE_ALIAS})) WITH ORDINALITY AS e(key, value, n))
  FROM (\n${sql}\n) AS ${CONSOLE_ALIAS} LIMIT ${Number(limit) + 1}`
}

/** Same statement with no rows: psql prints only the header (column names). */
function consoleHeaderSql(sql) {
  return `SELECT * FROM (\n${sql}\n) AS ${CONSOLE_ALIAS} LIMIT 0`
}

function parseConsole(out) {
  const pairs = jsonLines(out)
  if (!pairs.length) return { columns: [], rows: [] }
  return {
    columns: (pairs[0] || []).map(([key]) => key),
    rows: pairs.map((row) => (row || []).map(([, value]) => jsonCell(value))),
  }
}

/** Column names from `psql -A -z` header output (fields separated by NUL). */
function parseHeader(out) {
  const line = out.replace(/\r?\n$/, '')
  return line ? line.split('\0') : []
}

module.exports = {
  STATEMENT_TIMEOUT, OBJECTS_SQL, readOnly, writable, jsonLines, parseObjects, structureSql, parseStructure,
  rowsSql, parseRows, consoleSql, consoleHeaderSql, parseConsole, parseHeader, columnKind,
}
