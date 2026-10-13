const express = require('express')
const { startJob } = require('../jobs')
const { requireServer } = require('../servers')
const { getDriver } = require('../drivers')
const { runBackup, runRestore } = require('../pipeline')
const { isValidDbName, httpError } = require('../validation')
const { handle } = require('./util')

// POST /api/ops/:op   op = export | restore | create | delete | unblock
// Body: { serverId='local', engine='postgres', container?, database,
//         file? (restore), dropExisting? (restore), outputName? (export), options? (export) }

const router = express.Router()

/** Validate the common request shape and resolve server + driver. */
function resolveSpec(body) {
  const { serverId = 'local', engine = 'postgres', container, database } = body ?? {}
  if (!database) throw httpError(400, 'database is required')
  if (!isValidDbName(database)) throw httpError(400, `Invalid database name: ${database}`)
  const server = requireServer(serverId)
  if (server.kind === 'docker' && !container) throw httpError(400, 'container is required for Docker servers')
  const driver = getDriver(engine, server.kind)
  return { server, engine, container, database, driver }
}

function jobMeta(spec, extra = {}) {
  return {
    serverId: spec.server.id,
    serverName: spec.server.name,
    engine: spec.engine,
    container: spec.container,
    database: spec.database,
    ...extra,
  }
}

function startBackupJob(body, user, extraMeta = {}) {
  const spec = resolveSpec(body)
  if (body.outputName && !isValidDbName(body.outputName)) throw httpError(400, `Invalid export name: ${body.outputName}`)
  return startJob('export', jobMeta(spec, extraMeta),
    (job) => runBackup(job, { ...spec, outputName: body.outputName, scheduleId: extraMeta.scheduleId, options: body.options }),
    { username: user?.username })
}

function startRestoreJob(body, user) {
  const spec = resolveSpec(body)
  if (!body.file) throw httpError(400, 'file is required')
  return startJob('restore', jobMeta(spec, { file: body.file, dropExisting: !!body.dropExisting }),
    (job) => runRestore(job, { ...spec, file: body.file, dropExisting: body.dropExisting === true || body.dropExisting === 'true' }),
    { username: user?.username })
}

const SIMPLE_OPS = {
  create: 'create',
  delete: 'drop',
  unblock: 'unblock',
}

router.post('/ops/:op', handle(async (req, res) => {
  const { op } = req.params
  if (op === 'export') return res.json({ jobId: startBackupJob(req.body ?? {}, req.user) })
  if (op === 'restore') return res.json({ jobId: startRestoreJob(req.body ?? {}, req.user) })

  const method = SIMPLE_OPS[op]
  if (!method) throw httpError(404, `Unknown operation: ${op}`)
  const spec = resolveSpec(req.body)
  if (typeof spec.driver[method] !== 'function') throw httpError(400, `${spec.driver.label} does not support '${op}'`)
  const jobId = startJob(op, jobMeta(spec),
    (job) => spec.driver[method](job, { server: spec.server, container: spec.container }, { database: spec.database }),
    { username: req.user?.username })
  res.json({ jobId })
}))

module.exports = { router, startBackupJob, startRestoreJob }
