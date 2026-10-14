const { getServer } = require('../servers')
const { getDriver } = require('../drivers')
const { isValidDbName, CONTAINER_RE, httpError } = require('../validation')
const { cronError, defaultTimezone } = require('./cron')

// Input validation for schedule create/update requests.

const MAX_NAME_LENGTH = 100
const MAX_OPTIONS_BYTES = 4096
// Docker container names/ids: [a-zA-Z0-9][a-zA-Z0-9_.-]*

const EDITABLE = ['name', 'enabled', 'cron', 'timezone', 'serverId', 'engine', 'container', 'database', 'outputName', 'options']

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

function checkName(name) {
  if (typeof name !== 'string' || !name.trim()) throw httpError(400, 'Name is required')
  if (name.trim().length > MAX_NAME_LENGTH) throw httpError(400, `Name must be at most ${MAX_NAME_LENGTH} characters`)
  return name.trim()
}

function checkTarget({ serverId, engine, container, database, outputName }) {
  const server = getServer(serverId)
  if (!server) throw httpError(400, `Unknown server: ${serverId}`)
  getDriver(engine, server.kind) // throws 400 for unsupported engines
  if (server.kind === 'docker' && !container) throw httpError(400, 'Container is required for Docker servers')
  if (container && !CONTAINER_RE.test(container)) throw httpError(400, `Invalid container name: ${container}`)
  if (!isValidDbName(database)) throw httpError(400, `Invalid database name: ${database}`)
  if (outputName && !isValidDbName(outputName)) throw httpError(400, `Invalid output name: ${outputName}`)
}

function checkOptions(options) {
  if (!isPlainObject(options)) throw httpError(400, 'Backup options must be an object')
  if (JSON.stringify(options).length > MAX_OPTIONS_BYTES) throw httpError(400, 'Backup options are too large')
  return options
}

/**
 * Merge a request body over an existing schedule (or defaults) and validate it.
 * Unknown fields are ignored. Throws a 400 httpError on invalid input.
 * @param {object} body  request body
 * @param {object} [existing]  current schedule for partial updates
 * @returns {object} normalized schedule fields
 */
function normalizeSchedule(body, existing) {
  if (!isPlainObject(body)) throw httpError(400, 'Request body must be a JSON object')
  const base = existing || { enabled: true, timezone: defaultTimezone(), serverId: 'local', engine: 'postgres', options: {} }
  const picked = Object.fromEntries(EDITABLE.filter((k) => body[k] !== undefined).map((k) => [k, body[k]]))
  const merged = { ...base, ...picked }

  if (typeof merged.enabled !== 'boolean') throw httpError(400, 'Enabled must be true or false')
  const cron = typeof merged.cron === 'string' ? merged.cron.trim().replace(/\s+/g, ' ') : merged.cron
  const err = cronError(cron, merged.timezone)
  if (err) throw httpError(400, err)

  const normalized = {
    name: checkName(merged.name),
    enabled: merged.enabled,
    cron,
    timezone: merged.timezone,
    serverId: String(merged.serverId || ''),
    engine: String(merged.engine || ''),
    container: merged.container ? String(merged.container) : null,
    database: merged.database,
    outputName: merged.outputName ? String(merged.outputName) : null,
    options: checkOptions(merged.options ?? {}),
  }
  checkTarget(normalized)
  return normalized
}

module.exports = { normalizeSchedule }
