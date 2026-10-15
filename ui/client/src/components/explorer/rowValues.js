// Value handling for the row dialog: which input a column gets, whether it
// can be edited here, and how drafts become the JSON values sent to
// PATCH/DELETE /api/explorer/row.
//
// Column type to input and JSON type sent:
//   json      PostgreSQL json/jsonb, MySQL json, MongoDB object/array or mixed types -> parsed JSON value
//   boolean   PostgreSQL boolean, MongoDB bool                                     -> true / false
//   integer   smallint, integer, int, tinyint (MySQL booleans too), mediumint, MongoDB int -> number
//   float     real, float, double, MongoDB double (or int|double)                     -> number
//   exact     bigint, numeric, decimal: digits kept exact                            -> string, the server casts
//   text      everything else (text, dates, times, uuid, enum, ...)                    -> string, the server casts
// Not editable here: PostgreSQL arrays, and MongoDB fields whose sampled types
// include anything but string, int, double, bool, object or array (dates,
// ObjectIds, longs, decimals arrive as text and would come back as strings).

const MONGO_KINDS = { string: 'text', int: 'integer', double: 'float', bool: 'boolean', object: 'json', array: 'json' }
const NUMERIC = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/
const WHOLE = /^[+-]?\d+$/
const LONG_TEXT = 80

function mongoKind(type) {
  const types = type.split('|').filter((t) => t && t !== 'null' && t !== 'undefined')
  if (types.some((t) => !(t in MONGO_KINDS))) return 'unsupported'
  const kinds = [...new Set(types.map((t) => MONGO_KINDS[t]))]
  if (kinds.length === 0) return 'json'
  if (kinds.length === 1) return kinds[0]
  if (kinds.every((k) => k === 'integer' || k === 'float')) return 'float'
  return 'json'
}

/** @returns {'json'|'boolean'|'integer'|'float'|'exact'|'text'|'array'|'unsupported'} */
export function typeKind(engine, type) {
  const t = String(type || '').toLowerCase().trim()
  if (engine === 'mongodb') return mongoKind(t)
  if (t.endsWith('[]')) return 'array'
  if (/^jsonb?$/.test(t)) return 'json'
  if (engine === 'postgres' && /^bool(ean)?$/.test(t)) return 'boolean'
  if (/^(bigint|int8|numeric|decimal)\b/.test(t)) return 'exact'
  if (/^(smallint|integer|int|int2|int4|tinyint|mediumint)\b/.test(t)) return 'integer'
  if (/^(real|float|float4|float8|double)\b/.test(t)) return 'float'
  return 'text'
}

export const isBinaryCell = (cell) => Boolean(cell && typeof cell === 'object' && cell.binary === true)
export const isTruncatedCell = (cell) => Boolean(cell && typeof cell === 'object' && cell.truncated === true)
const isPartial = (cell) => isBinaryCell(cell) || isTruncatedCell(cell)

/** Primary key columns: `structure.primaryKey`, or the columns flagged as primary key. */
export function primaryKeyOf(structure) {
  if (Array.isArray(structure?.primaryKey) && structure.primaryKey.length) return structure.primaryKey
  return (structure?.columns || []).filter((c) => c.primaryKey).map((c) => c.name)
}

/** Why a field cannot be edited here, or null when it can. */
function lockReason(engine, column, cell, isKey, kind) {
  if (isKey) return 'Primary key. It can\'t be changed here.'
  if (!column) return 'Not in the sampled structure, so its type is unknown.'
  if (isBinaryCell(cell)) return 'Binary value. It can\'t be edited here.'
  if (isTruncatedCell(cell)) {
    return `Too long to edit here (${Number(cell.length).toLocaleString()} characters). Use a database client.`
  }
  if (column.editable === false) {
    return /bytea|blob|binary/i.test(column.type) ? 'Binary column. It can\'t be edited here.' : 'Set by the database (generated column). It can\'t be edited here.'
  }
  if (kind === 'array') return 'Array column. It can\'t be edited here.'
  if (kind === 'unsupported') return `Holds ${column.type} values, which can't be edited here.`
  if (engine === 'mongodb' && cell && typeof cell === 'object' && kind !== 'json') return 'Holds a nested value of another type. It can\'t be edited here.'
  return null
}

/**
 * One entry per column of the loaded row.
 * @returns {{ name: string, cell: unknown, column: object|null, isKey: boolean, kind: string,
 *   nullable: boolean, lock: string|null }[]}
 */
export function buildFields({ engine, columns, row, structure }) {
  const byName = new Map((structure?.columns || []).map((c) => [c.name, c]))
  const keyCols = new Set(primaryKeyOf(structure))
  return columns.map((name, i) => {
    const cell = row[i] === undefined ? null : row[i]
    const column = byName.get(name) || null
    const isKey = keyCols.has(name)
    const kind = column ? typeKind(engine, column.type) : 'text'
    return { name, cell, column, isKey, kind, nullable: Boolean(column?.nullable), lock: lockReason(engine, column, cell, isKey, kind) }
  })
}

/** `{ col: value }` for the primary key, or null when a key value is missing or was cut. */
export function keyOf(fields, structure) {
  const keyCols = primaryKeyOf(structure)
  if (!keyCols.length) return null
  const key = {}
  for (const name of keyCols) {
    const field = fields.find((f) => f.name === name)
    if (!field || isPartial(field.cell)) return null
    key[name] = field.cell
  }
  return key
}

/** Starting input state of an editable field. */
export function initialDraft(field) {
  const { cell, kind } = field
  if (cell === null) return { text: '', isNull: true }
  if (kind === 'json') return { text: JSON.stringify(cell, null, 2), isNull: false }
  if (kind === 'boolean') return { text: cell ? 'true' : 'false', isNull: false }
  return { text: typeof cell === 'object' ? JSON.stringify(cell) : String(cell), isNull: false }
}

export function isDraftChanged(field, draft) {
  const start = initialDraft(field)
  return draft.isNull !== start.isNull || (!draft.isNull && draft.text !== start.text)
}

export const usesTextarea = (field, text) => field.kind === 'json' || text.length > LONG_TEXT || text.includes('\n')

/** Draft to the JSON value sent to the server: `{ value }` or `{ error }`. */
export function readDraft(field, draft) {
  if (draft.isNull) return { value: null }
  const trimmed = draft.text.trim()
  const emptyHint = field.nullable ? 'Enter a value, or tick NULL.' : 'Enter a value.'
  switch (field.kind) {
    case 'boolean':
      return { value: draft.text === 'true' }
    case 'integer':
      if (!trimmed) return { error: emptyHint }
      if (!WHOLE.test(trimmed) || !Number.isSafeInteger(Number(trimmed))) return { error: 'Enter a whole number.' }
      return { value: Number(trimmed) }
    case 'float':
      if (!trimmed) return { error: emptyHint }
      if (!NUMERIC.test(trimmed) || !Number.isFinite(Number(trimmed))) return { error: 'Enter a number, for example 12.5.' }
      return { value: Number(trimmed) }
    case 'exact':
      if (!trimmed) return { error: emptyHint }
      if (!NUMERIC.test(trimmed)) return { error: 'Enter a number, for example 12.5.' }
      return { value: trimmed }
    case 'json':
      if (!trimmed) return { error: emptyHint }
      try {
        return { value: JSON.parse(trimmed) }
      } catch (e) {
        return { error: `Not valid JSON: ${e.message}` }
      }
    default:
      return { value: draft.text }
  }
}

/**
 * `changes` and `original` for PATCH: only fields whose draft differs from
 * the loaded value; `original` carries those loaded values.
 * @returns {{ changes: object, original: object, errors: object }}
 */
export function buildUpdate(fields, drafts) {
  const changes = {}
  const original = {}
  const errors = {}
  for (const field of fields) {
    const draft = drafts[field.name]
    if (field.lock || !draft || !isDraftChanged(field, draft)) continue
    const result = readDraft(field, draft)
    if (result.error) errors[field.name] = result.error
    else {
      changes[field.name] = result.value
      original[field.name] = field.cell
    }
  }
  return { changes, original, errors }
}

/** `original` for DELETE: every loaded value that is complete (not cut, not binary), key columns excluded. */
export function buildDeleteOriginal(fields) {
  const original = {}
  for (const field of fields) {
    if (!field.isKey && !isPartial(field.cell)) original[field.name] = field.cell
  }
  return original
}

/** "id = 42, region = 'eu'" for the confirmation step and the dialog subtitle. */
export function describeKey(key) {
  return Object.entries(key).map(([col, value]) => `${col} = ${typeof value === 'string' ? `'${value}'` : JSON.stringify(value)}`).join(', ')
}
