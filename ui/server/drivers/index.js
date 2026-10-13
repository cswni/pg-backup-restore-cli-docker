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
 *   create(job, target, { database }) -> Promise<void>
 *   drop(job, target, { database }) -> Promise<void>
 *   unblock(job, target, { database }) -> Promise<void>   // optional
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

function listEngines() {
  const seen = new Map()
  for (const d of drivers.values()) {
    const e = seen.get(d.engine) || { engine: d.engine, label: d.label, kinds: [] }
    e.kinds.push(d.kind)
    seen.set(d.engine, e)
  }
  return [...seen.values()]
}

// Built-in drivers
registerDriver(require('./postgres-docker'))

module.exports = { registerDriver, getDriver, listEngines }
