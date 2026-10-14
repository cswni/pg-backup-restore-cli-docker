const express = require('express')
const { startJob, listJobs } = require('../jobs')
const { requireServer } = require('../servers')
const { getDriver } = require('../drivers')
const { runBackup, runRestore } = require('../pipeline')
const { isValidDbName, isValidContainerName, httpError } = require('../validation')
const { handle } = require('./util')

// POST /api/ops/:op   op = export | restore | create | delete | unblock
// Body: { serverId='local', engine='postgres', container?, database,
//         file? (restore), dropExisting? (restore), outputName? (export), options? (export) }

const router = express.Router()

/** Validate the common request shape and resolve server + driver. */
function resolveSpec(body) {
  const { serverId = 'local', engine = 'postgres', container, database } = body ?? {}
  if (!database) throw httpError(400, 'Database is required')
  if (!isValidDbName(database)) throw httpError(400, `Invalid database name: ${database}`)
  const server = requireServer(serverId)
  if (server.kind === 'docker' && !container) throw httpError(400, 'Container is required for Docker servers')
  if (container && !isValidContainerName(container)) throw httpError(400, `Invalid container name: ${container}`)
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

/**
 * Per-backup storage options (compression, encryption, destinations) can
 * override the admin's defaults, so only admins and schedules (created by
 * admins) may set them; other users always get the configured defaults.
 */
function allowedOptions(body, user, extraMeta) {
  return user?.role === 'admin' || extraMeta.scheduleId ? body.options : undefined
}

// Non-admin users can't queue unlimited dumps (each holds a DB connection,
// CPU and disk); admins and schedules are not limited.
const MAX_RUNNING_BACKUPS_PER_USER = 2

function assertBackupCapacity(user, extraMeta) {
  if (user?.role === 'admin' || extraMeta.scheduleId) return
  const running = listJobs({ type: 'export', status: 'running', limit: 500 })
    .filter((j) => j.username === user?.username).length
  if (running >= MAX_RUNNING_BACKUPS_PER_USER) {
    throw httpError(429, `You already have ${running} backups running; wait for them to finish`)
  }
}

function startBackupJob(body, user, extraMeta = {}) {
  assertBackupCapacity(user, extraMeta)
  const spec = resolveSpec(body)
  if (body.outputName && !isValidDbName(body.outputName)) throw httpError(400, `Invalid export name: ${body.outputName}`)
  const options = allowedOptions(body, user, extraMeta)
  return startJob('export', jobMeta(spec, extraMeta),
    (job) => runBackup(job, { ...spec, outputName: body.outputName, scheduleId: extraMeta.scheduleId, options }),
    { username: user?.username })
}

function startRestoreJob(body, user) {
  const spec = resolveSpec(body)
  if (!body.file) throw httpError(400, 'Backup file is required')
  return startJob('restore', jobMeta(spec, { file: body.file, dropExisting: !!body.dropExisting }),
    (job) => runRestore(job, { ...spec, file: body.file, dropExisting: body.dropExisting === true || body.dropExisting === 'true' }),
    { username: user?.username })
}

const SIMPLE_OPS = {
  create: 'create',
  delete: 'drop',
  unblock: 'unblock',
}

/**
 * Only backups are open to every role. Restores run psql/mysql on a dump,
 * and those clients execute meta-commands such as `\!` (shell) embedded in
 * the file. For direct servers they run inside this container, which has the Docker
 * socket mounted. Restores and schema changes are therefore admin-only.
 */
function assertCanRun(op, user) {
  if (op !== 'export' && user?.role !== 'admin') throw httpError(403, `Admin role required for '${op}'`)
}

router.post('/ops/:op', handle(async (req, res) => {
  const { op } = req.params
  assertCanRun(op, req.user)
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

module.exports = { router, startBackupJob, startRestoreJob, assertCanRun }
