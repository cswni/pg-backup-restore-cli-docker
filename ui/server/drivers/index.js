/**
 * Database engine drivers.
 *
 * A driver performs operations for one engine (postgres, mysql, mongodb…)
 * reached in one way (server.kind: 'docker' or 'direct'). Drivers are
 * registered with `registerDriver` and looked up by engine + server kind.
 *
 * Driver shape:
 * {
 *   engine: 'postgres',
 *   kind: 'docker',                 // matches server.kind
 *   label: 'PostgreSQL',
 *   fileExtension: '.sql',          // extension of the raw dump file
 *   // target = { server, container? }   (container only for kind 'docker')
 *   listDatabases(target) -> Promise<string[]>
 *   dump(job, target, { database, outFile }) -> Promise<void>
 *   restore(job, target, { database, inFile, dropExisting }) -> Promise<void>
 *   create(job, target, { database }) -> Promise<void>    // optional (MongoDB has none)
 *   drop(job, target, { database }) -> Promise<void>
 *   unblock(job, target, { database }) -> Promise<void>   // optional
 *   testConnection(target) -> Promise<{ version }>         // direct servers
 * Missing optional methods are hidden in the UI (listEngines().operations).
 * }
 * `job` is the object from jobs.startJob: use job.log() / jobs.runCommand(job, …).
 * Every method receives already-validated database names (validation.isValidDbName).
 */
const drivers = new Map()

function registerDriver(driver) {
  drivers.set(`${driver.engine}:${driver.kind}`, driver)
}

function getDriver(engine, kind) {
  const driver = drivers.get(`${engine}:${kind}`)
  if (!driver) {
    const err = new Error(`No driver for engine '${engine}' on '${kind}' servers`)
    err.status = 400
    throw err
  }
  return driver
}

// UI operation id → driver method
const OPERATION_METHODS = { export: 'dump', restore: 'restore', create: 'create', delete: 'drop', unblock: 'unblock' }

/** Operation ids (as used by POST /api/ops/:op) a driver implements. */
function driverOperations(driver) {
  return Object.entries(OPERATION_METHODS).filter(([, m]) => typeof driver[m] === 'function').map(([op]) => op)
}

/**
 * Engines with their capabilities, for GET /api/engines:
 * { engine, label, fileExtension, kinds: ['docker', 'direct'], operations: { docker: [...], direct: [...] } }
 */
function listEngines() {
  const seen = new Map()
  for (const d of drivers.values()) {
    const e = seen.get(d.engine) || { engine: d.engine, label: d.label, fileExtension: d.fileExtension, kinds: [], operations: {} }
    e.kinds.push(d.kind)
    e.operations[d.kind] = driverOperations(d)
    seen.set(d.engine, e)
  }
  return [...seen.values()]
}

// Built-in drivers
registerDriver(require('./postgres-docker'))
registerDriver(require('./postgres-direct'))
registerDriver(require('./mysql-docker'))
registerDriver(require('./mysql-direct'))
registerDriver(require('./mongodb-docker'))
registerDriver(require('./mongodb-direct'))

module.exports = { registerDriver, getDriver, listEngines }
