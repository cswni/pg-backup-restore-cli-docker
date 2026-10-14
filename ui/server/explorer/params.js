const { requireServer } = require('../servers')
const { isValidDbName, isValidContainerName, httpError } = require('../validation')
const { getAdapter } = require('./adapters')

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200
const DEFAULT_QUERY_LIMIT = 200
const MAX_QUERY_LIMIT = 500
const MAX_OFFSET = 1e9
const MAX_NAME_LENGTH = 255
const MAX_FILTER_LENGTH = 10000

/**
 * Parse a non-negative integer parameter.
 * @param {unknown} value  raw query/body value; undefined or '' gives `def`
 * @param {{ label: string, min: number, max: number, def: number }} spec
 */
function intParam(value, { label, min, max, def }) {
  if (value === undefined || value === null || value === '') return def
  const text = String(value)
  if (!/^\d{1,10}$/.test(text)) throw httpError(400, `${label} must be a whole number`)
  const n = Number(text)
  if (n < min || n > max) throw httpError(400, `${label} must be between ${min} and ${max}`)
  return n
}

/** Optional string parameter of bounded length; '' counts as missing. */
function optionalString(value, label) {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string') throw httpError(400, `${label} must be text`)
  if (value.length > MAX_NAME_LENGTH) throw httpError(400, `${label} is too long`)
  return value
}

/**
 * Server, engine, container, database and adapter for an explorer request.
 * Direct servers have one engine; Docker servers need `engine` and `container`.
 */
function resolveTarget(params) {
  const { serverId = 'local', engine: engineParam, container, database } = params ?? {}
  if (typeof serverId !== 'string') throw httpError(400, 'Choose a server')
  const server = requireServer(serverId)
  const engine = engineParam || (server.kind === 'direct' ? server.engine : 'postgres')
  if (typeof engine !== 'string') throw httpError(400, 'Choose a database engine')
  if (server.kind === 'direct' && engine !== server.engine) {
    throw httpError(400, `${server.name} is a ${server.engine} server, not ${engine}`)
  }
  if (server.kind === 'docker') {
    if (!container) throw httpError(400, 'Choose a container')
    if (!isValidContainerName(container)) throw httpError(400, `Invalid container name: ${container}`)
  }
  if (!database) throw httpError(400, 'Choose a database')
  if (!isValidDbName(database)) throw httpError(400, `Invalid database name: ${database}`)
  const adapter = getAdapter(engine, server.kind)
  const target = server.kind === 'docker' ? { server, container } : { server }
  return { server, engine, target, database, adapter }
}

/** The object named by `schema` + `name`, looked up in the catalog listing. */
function findObject(objects, params) {
  const name = optionalString(params.name, 'Table name')
  if (!name) throw httpError(400, 'Choose a table or collection')
  const schema = optionalString(params.schema, 'Schema')
  const matches = objects.filter((o) => o.name === name && (schema === null || o.schema === schema))
  if (!matches.length) {
    throw httpError(404, `No table, view or collection named ${schema ? `${schema}.` : ''}${name} in this database`)
  }
  if (matches.length > 1) throw httpError(400, `Several schemas contain ${name}; choose a schema`)
  return matches[0]
}

/** Paging, sorting and filter options for GET /explorer/rows. */
function rowOptions(query, engine) {
  const limit = intParam(query.limit, { label: 'Rows per page', min: 1, max: MAX_LIMIT, def: DEFAULT_LIMIT })
  const offset = intParam(query.offset, { label: 'Offset', min: 0, max: MAX_OFFSET, def: 0 })
  const sort = optionalString(query.sort, 'Sort column')
  const dir = query.dir === undefined || query.dir === '' ? 'asc' : query.dir
  if (dir !== 'asc' && dir !== 'desc') throw httpError(400, 'Sort direction must be asc or desc')
  const filter = query.filter === undefined || query.filter === '' ? null : query.filter
  if (filter !== null && typeof filter !== 'string') throw httpError(400, 'Filter must be text')
  if (filter !== null && filter.length > MAX_FILTER_LENGTH) throw httpError(400, `Filter is longer than ${MAX_FILTER_LENGTH} characters`)
  if (filter !== null && engine !== 'mongodb') throw httpError(400, 'Filters are only available for MongoDB')
  return { limit, offset, sort, dir, filter }
}

/** Row limit for the SQL console. */
function queryLimit(value) {
  return intParam(value, { label: 'Row limit', min: 1, max: MAX_QUERY_LIMIT, def: DEFAULT_QUERY_LIMIT })
}

module.exports = {
  intParam, resolveTarget, findObject, rowOptions, queryLimit,
  DEFAULT_LIMIT, MAX_LIMIT, MAX_QUERY_LIMIT,
}
