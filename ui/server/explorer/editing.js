const { httpError } = require('../validation')
const { startJob } = require('../jobs')

// Row edits from the Explorer (admin only): request checks against the
// catalog, the editable view of a structure, and the audit job around each
// change. Engine SQL and commands live in postgres-write.js, mysql-write.js
// and mongodb-edit.js.

const CONFLICT_MESSAGE = 'This row changed or no longer exists. Reload and try again.'
// Values travel on the docker exec command line for Docker servers, and the
// MySQL hex literals double their size; Linux caps one argument at 128 KiB.
const MAX_REQUEST_JSON_LENGTH = 48000
const MAX_NAME_LENGTH = 255

const isPlainObject = (v) => v !== null && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype

function hasExactKeys(value, keys) {
  const own = Object.keys(value)
  return own.length === keys.length && keys.every((k) => own.includes(k))
}

/** A cell the browser received in place of a value it never saw in full. */
function isPlaceholderCell(value) {
  if (!isPlainObject(value)) return false
  if (value.truncated === true && hasExactKeys(value, ['truncated', 'value', 'length'])) return true
  return value.binary === true && hasExactKeys(value, ['binary', 'length', 'preview'])
}

function checkValue(column, value, label) {
  if (value === undefined) throw httpError(400, `${label} for ${column} is missing`)
  if (isPlaceholderCell(value)) {
    throw httpError(400, `${column} holds a cut or binary value that cannot be used here; only fully loaded values can`)
  }
  if (typeof value === 'number' && Number.isInteger(value) && !Number.isSafeInteger(value)) {
    throw httpError(400, `${column} is too large to be sent exactly as a number`)
  }
}

function valueMap(raw, label, { required }) {
  if (raw === undefined || raw === null) {
    if (required) throw httpError(400, `${label} is missing`)
    return {}
  }
  if (!isPlainObject(raw)) throw httpError(400, `${label} must be an object of column values`)
  for (const [column, value] of Object.entries(raw)) {
    if (!column || column.length > MAX_NAME_LENGTH) throw httpError(400, `${label} has an invalid column name`)
    checkValue(column, value, label)
  }
  return raw
}

/**
 * Shape checks for PATCH / DELETE /explorer/row, before any connection.
 * @param {object} body
 * @param {'update'|'delete'} op
 * @returns {{ key: object, original: object, changes: object }}
 */
function parseRowRequest(body, op) {
  const key = valueMap(body.key, 'The row key', { required: true })
  if (!Object.keys(key).length) throw httpError(400, 'The row key is empty')
  for (const [column, value] of Object.entries(key)) {
    if (value === null) throw httpError(400, `The key column ${column} cannot be NULL`)
  }
  const original = valueMap(body.original, 'The original values', { required: op === 'update' })
  const changes = op === 'update' ? valueMap(body.changes, 'The changes', { required: true }) : {}
  if (op === 'update' && !Object.keys(changes).length) throw httpError(400, 'Nothing to change')
  if (JSON.stringify({ key, original, changes }).length > MAX_REQUEST_JSON_LENGTH) {
    throw httpError(400, `The values are too large to edit here (more than ${MAX_REQUEST_JSON_LENGTH} characters in total)`)
  }
  return { key, original, changes }
}

function readOnlyReason(object, structure, primaryKey) {
  if (object.type === 'view') return 'Views are read-only here.'
  if (structure.readOnlyReason) return structure.readOnlyReason
  if (!primaryKey.length) return 'This table has no primary key, so a single row cannot be addressed.'
  return null
}

/**
 * Structure as the API returns it: public column fields plus `editable`,
 * `editableReason`, `primaryKey` and per-column `editable`. Engine parsers
 * set column.editable (false for key, binary and generated columns).
 */
function editableStructure(engine, object, structure) {
  const primaryKey = engine === 'mongodb'
    ? (object.type === 'collection' ? ['_id'] : [])
    : structure.columns.filter((c) => c.primaryKey).map((c) => c.name)
  const reason = readOnlyReason(object, structure, primaryKey)
  return {
    columns: structure.columns.map((c) => ({
      name: c.name, type: c.type, nullable: c.nullable, default: c.default, primaryKey: c.primaryKey,
      editable: reason === null && c.editable === true,
    })),
    indexes: structure.indexes,
    editable: reason === null,
    editableReason: reason,
    primaryKey,
  }
}

function assertMongoField(field) {
  if (field.startsWith('$') || field.includes('.') || field.includes('\0')) {
    throw httpError(400, `${field} is not a field name that can be edited here (no leading $, no dots)`)
  }
}

/**
 * Check a parsed request against the editable structure. Columns must exist
 * (MongoDB: fields are sampled, so unseen fields are accepted when their
 * name is plain). Returns `original` without key columns.
 */
function checkRowRequest(request, structure, engine) {
  if (!structure.editable) throw httpError(400, structure.editableReason)
  const byName = new Map(structure.columns.map((c) => [c.name, c]))
  const { key, original, changes } = request
  const isMongo = engine === 'mongodb'

  for (const column of structure.primaryKey) {
    if (!(column in key)) throw httpError(400, `The row key is missing the primary key column ${column}`)
  }
  for (const column of Object.keys(key)) {
    if (!structure.primaryKey.includes(column)) throw httpError(400, `${column} is not part of the primary key`)
  }

  const known = (column) => {
    const col = byName.get(column)
    if (!col && !isMongo) throw httpError(400, `No column named ${column}`)
    if (!col) assertMongoField(column)
    return col
  }

  for (const column of Object.keys(changes)) {
    if (structure.primaryKey.includes(column)) throw httpError(400, `${column} is part of the primary key and cannot be changed`)
    const col = known(column)
    if (col && !col.editable) throw httpError(400, `${column} cannot be edited here (generated or binary column)`)
    if (!(column in original)) throw httpError(400, `The original value of ${column} is missing`)
  }

  const compared = {}
  for (const [column, value] of Object.entries(original)) {
    if (structure.primaryKey.includes(column)) {
      if (JSON.stringify(value) !== JSON.stringify(key[column])) throw httpError(400, `The original value of ${column} differs from the row key`)
      continue
    }
    known(column)
    compared[column] = value
  }
  return { key, original: compared, changes }
}

/**
 * Run `change()` (resolving with the number of rows matched) as an audit job
 * and wait for it. 0 rows is a conflict: the job fails and the caller gets 409.
 * @returns {Promise<string>} job id
 */
async function runRowJob({ type, meta, username, describe }, change) {
  let settle
  const outcome = new Promise((resolve, reject) => { settle = { resolve, reject } })
  const jobId = startJob(type, meta, async (job) => {
    try {
      const matched = await change()
      if (!matched) throw httpError(409, CONFLICT_MESSAGE)
      job.log(describe)
      settle.resolve()
    } catch (err) {
      settle.reject(err)
      throw err
    }
  }, { username })
  await outcome
  return jobId
}

/** Job metadata: where, which row (key values) and which columns; never the new values. */
function rowJobMeta(ctx, object, request) {
  return {
    serverId: ctx.server.id,
    serverName: ctx.server.name,
    engine: ctx.engine,
    container: ctx.target.container,
    database: ctx.database,
    schema: object.schema,
    object: object.name,
    key: request.key,
    columns: Object.keys(request.changes),
  }
}

module.exports = {
  CONFLICT_MESSAGE, MAX_REQUEST_JSON_LENGTH,
  isPlaceholderCell, parseRowRequest, editableStructure, checkRowRequest, runRowJob, rowJobMeta,
}
