const { isDeepStrictEqual } = require('util')
const { BSON } = require('mongodb')
const { httpError } = require('../validation')
const { mongoCell } = require('./mongodb-bson')

// Row edits for MongoDB, shared by the Docker (mongosh) and direct (driver)
// adapters through a small store: find / updateOne / deleteOne.
//
// The browser only has display values (an ObjectId as its hex string, a date
// as ISO text), so the document is read first and its fields are compared
// the way they were displayed. The write then filters on `_id` plus the raw
// BSON values just read (`$eq`), so a concurrent change still matches nothing.

const { EJSON, ObjectId, Long } = BSON
// Documents fetched while resolving a displayed _id (a hex string may be an ObjectId or a string).
const MAX_ID_CANDIDATES = 3

const isPlainObject = (v) => v !== null && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype

function assertNoOperators(value, path) {
  if (value?._bsontype === 'Code') throw httpError(400, `JavaScript code is not allowed in values (${path})`)
  if (Array.isArray(value)) return value.forEach((v, i) => assertNoOperators(v, `${path}[${i}]`))
  if (!isPlainObject(value)) return undefined
  for (const [key, v] of Object.entries(value)) {
    if (key.startsWith('$')) throw httpError(400, `Field names starting with $ are not allowed in values (${path}.${key})`)
    assertNoOperators(v, `${path}.${key}`)
  }
  return undefined
}

/**
 * Browser JSON value to BSON, read as Extended JSON ({"$oid": …}, {"$date": …}).
 * Any `$` key left after that would be an operator, so it is refused.
 */
function parseValue(value, path) {
  let parsed
  try {
    parsed = EJSON.parse(JSON.stringify(value), { relaxed: false })
  } catch (err) {
    throw httpError(400, `${path} is not valid Extended JSON: ${err.message}`)
  }
  assertNoOperators(parsed, path)
  return parsed
}

/** Validate every value of a request before a job starts. */
function checkValues({ key, original, changes }) {
  for (const [field, value] of Object.entries({ ...key, ...original, ...changes })) parseValue(value, field)
}

/** BSON values a displayed `_id` may stand for. */
function idCandidates(value) {
  if (typeof value !== 'string') return [parseValue(value, '_id')]
  const candidates = [value]
  if (/^[0-9a-f]{24}$/i.test(value)) candidates.push(new ObjectId(value))
  if (/^-?\d{1,19}$/.test(value)) {
    const long = Long.fromString(value)
    if (long.toString() === value) candidates.push(long)
  }
  return candidates
}

/** True when the browser's value is how `raw` was displayed, or its Extended JSON. */
function sameValue(raw, sent) {
  if (isDeepStrictEqual(mongoCell(raw), sent)) return true
  if (raw === undefined || sent === null || typeof sent !== 'object') return false
  try {
    const canonical = (v) => EJSON.stringify(v, { relaxed: false })
    return canonical(raw) === canonical(EJSON.parse(JSON.stringify(sent), { relaxed: false }))
  } catch {
    return false
  }
}

/** Filter for the write, or null when the document is gone or differs from `original`. */
async function targetFilter(store, object, { key, original }) {
  const docs = await store.find(object, { _id: { $in: idCandidates(key._id) } }, MAX_ID_CANDIDATES)
  const matches = docs.filter((doc) => sameValue(doc._id, key._id))
  if (matches.length > 1) throw httpError(400, 'Several documents match this _id; send it as Extended JSON, for example {"$oid": "…"}')
  const [doc] = matches
  if (!doc) return null
  const fields = Object.keys(original).filter((field) => field !== '_id')
  if (!fields.every((field) => sameValue(doc[field], original[field]))) return null
  return { _id: doc._id, ...Object.fromEntries(fields.map((field) => [field, { $eq: doc[field] === undefined ? null : doc[field] }])) }
}

/**
 * @param {{ find: Function, updateOne: Function, deleteOne: Function }} store
 * @returns {Promise<number>} documents matched (0 or 1)
 */
async function updateRow(store, object, request) {
  const set = Object.fromEntries(Object.entries(request.changes).map(([field, value]) => [field, parseValue(value, field)]))
  const filter = await targetFilter(store, object, request)
  if (!filter) return 0
  const { matchedCount } = await store.updateOne(object, filter, { $set: set })
  return Number(matchedCount)
}

async function deleteRow(store, object, request) {
  const filter = await targetFilter(store, object, request)
  if (!filter) return 0
  const { deletedCount } = await store.deleteOne(object, filter)
  return Number(deletedCount)
}

module.exports = { parseValue, checkValues, idCandidates, sameValue, updateRow, deleteRow }
