const { BSON } = require('mongodb')
const { httpError } = require('../validation')
const { textCell, bytesCell, MAX_TEXT } = require('./cells')

// MongoDB values for the explorer, shared by the Docker (mongosh) and direct
// (Node.js driver) adapters. Both hand over documents with BSON wrapper types
// (Int32, Long, Binary…): the driver with promoteValues: false, mongosh as
// canonical Extended JSON parsed with relaxed: false.

const SAMPLE_SIZE = 100
const MAX_TIME_MS = 10000
// Operators that run JavaScript on the server.
const FORBIDDEN_OPERATORS = new Set(['$where', '$function', '$accumulator'])

const isPlainObject = (v) => v !== null && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype

function assertSafeFilter(value, path = 'filter') {
  if (value?._bsontype === 'Code') throw httpError(400, `JavaScript code is not allowed in the filter (${path})`)
  if (Array.isArray(value)) return value.forEach((v, i) => assertSafeFilter(v, `${path}[${i}]`))
  if (!isPlainObject(value)) return undefined
  for (const [key, v] of Object.entries(value)) {
    if (FORBIDDEN_OPERATORS.has(key)) throw httpError(400, `${key} is not allowed in the filter`)
    assertSafeFilter(v, `${path}.${key}`)
  }
  return undefined
}

/**
 * Parse a filter typed by the user as Extended JSON (`{ "_id": { "$oid": "…" } }`).
 * Must be an object; operators that run JavaScript are refused anywhere in it.
 * @param {string|null} text
 * @returns {object}
 */
function parseFilter(text) {
  if (text === null || text === undefined || !String(text).trim()) return {}
  let filter
  try {
    filter = BSON.EJSON.parse(text, { relaxed: true })
  } catch (err) {
    throw httpError(400, `The filter is not valid JSON: ${err.message}`)
  }
  if (!isPlainObject(filter)) throw httpError(400, 'The filter must be a JSON object, for example {"status": "active"}')
  assertSafeFilter(filter)
  return filter
}

/** BSON type name as used by MongoDB's $type operator. */
function bsonType(value) {
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  if (value instanceof Date) return 'date'
  if (Array.isArray(value)) return 'array'
  switch (typeof value) {
    case 'string': return 'string'
    case 'boolean': return 'bool'
    case 'number': return Number.isInteger(value) ? 'int' : 'double'
    case 'bigint': return 'long'
    default: break
  }
  const types = {
    ObjectId: 'objectId', ObjectID: 'objectId', Int32: 'int', Double: 'double', Long: 'long', Decimal128: 'decimal',
    Binary: 'binData', Timestamp: 'timestamp', BSONRegExp: 'regex', Code: 'javascript', MinKey: 'minKey',
    MaxKey: 'maxKey', BSONSymbol: 'symbol', DBRef: 'dbPointer',
  }
  return types[value._bsontype] || (value instanceof RegExp ? 'regex' : 'object')
}

function binaryBytes(bin) {
  const length = typeof bin.length === 'function' ? bin.length() : bin.position
  return Buffer.from(bin.buffer.subarray(0, length))
}

/** BSON value to plain JSON (no truncation). */
function toJson(value) {
  if (value === null || value === undefined) return null
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString()
  if (Array.isArray(value)) return value.map(toJson)
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value)
  if (typeof value === 'bigint') return value.toString()
  if (typeof value !== 'object') return value
  switch (value._bsontype) {
    case 'ObjectId': case 'ObjectID': return value.toHexString()
    case 'Int32': return value.value
    case 'Double': return toJson(value.value)
    case 'Long': {
      const n = value.toNumber()
      return Number.isSafeInteger(n) ? n : value.toString()
    }
    case 'Decimal128': return value.toString()
    case 'Binary': return bytesCell(binaryBytes(value))
    case undefined: return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, toJson(v)]))
    default: return BSON.EJSON.serialize(value, { relaxed: true })
  }
}

/** One cell: long strings and large nested values come back as truncated text. */
function mongoCell(value) {
  if (value === undefined) return null
  if (value?._bsontype === 'Binary') return bytesCell(binaryBytes(value))
  const json = toJson(value)
  if (typeof json === 'string') return textCell(json)
  if (json !== null && typeof json === 'object' && !json.binary) {
    const text = JSON.stringify(json)
    if (text.length > MAX_TEXT) return textCell(text)
  }
  return json
}

/** Union of top-level fields in first-seen order, `_id` first. */
function fieldNames(docs) {
  const names = new Set(['_id'])
  for (const doc of docs) for (const key of Object.keys(doc)) names.add(key)
  if (!docs.some((d) => '_id' in d)) names.delete('_id')
  return [...names]
}

/** Columns and cells for a page of documents; a missing field is null. */
function docsToRows(docs) {
  const columns = fieldNames(docs)
  return { columns, rows: docs.map((doc) => columns.map((c) => mongoCell(doc[c]))) }
}

/** Columns inferred from sampled documents, indexes from listIndexes. */
function toStructure(sample, indexes) {
  const columns = fieldNames(sample).map((name) => {
    const types = new Set()
    let nullable = false
    for (const doc of sample) {
      if (!(name in doc) || doc[name] === null) nullable = true
      if (name in doc) types.add(bsonType(doc[name]))
    }
    return {
      name, type: [...types].join('|'), nullable, default: null, primaryKey: name === '_id',
      editable: name !== '_id' && !types.has('binData'),
    }
  })
  return {
    columns,
    indexes: indexes.map((ix) => ({ name: ix.name, columns: Object.keys(ix.key || {}), unique: ix.unique === true || ix.name === '_id_' })),
  }
}

/** find() options for a page; `sort` is a field from the sampled structure. */
function findOptions({ limit, offset, sort, dir }) {
  return { sort: sort ? { [sort]: dir === 'desc' ? -1 : 1 } : { _id: 1 }, skip: offset, limit: limit + 1, maxTimeMS: MAX_TIME_MS }
}

module.exports = {
  SAMPLE_SIZE, MAX_TIME_MS, parseFilter, bsonType, toJson, mongoCell, docsToRows, toStructure, findOptions,
}
