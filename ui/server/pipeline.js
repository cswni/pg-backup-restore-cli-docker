const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { BACKUPS_DIR } = require('./config')
const { getDriver } = require('./drivers')
const catalog = require('./catalog')

// Backup / restore pipelines with extension points.
//
// Backup:  driver.dump → raw file → post-backup steps (compress, encrypt,
//          upload to remote destinations, retention…) → catalog entry.
// Restore: resolve file → pre-restore steps (download, decrypt, decompress…)
//          → driver.restore → cleanup of temporary files.
//
// Steps are async functions `(ctx, job) => ctx` registered with an `order`
// (lower runs first). Suggested orders: compress 100, encrypt 200,
// upload 300, retention 900 for backup; download 100, decrypt 200,
// decompress 300 for restore.

const postBackupSteps = []
const preRestoreSteps = []

function addStep(list, name, order, fn) {
  list.push({ name, order, fn })
  list.sort((a, b) => a.order - b.order)
}

function registerPostBackupStep(name, order, fn) {
  addStep(postBackupSteps, name, order, fn)
}

function registerPreRestoreStep(name, order, fn) {
  addStep(preRestoreSteps, name, order, fn)
}

function timestamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${p(d.getDate())}-${p(d.getMonth() + 1)}-${d.getFullYear()}_${p(d.getHours())}_${p(d.getMinutes())}_${p(d.getSeconds())}`
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256')
    fs.createReadStream(file).on('error', reject).on('data', (d) => hash.update(d))
      .on('end', () => resolve(hash.digest('hex')))
  })
}

/**
 * Run a backup inside a job.
 * @param {object} job  from jobs.startJob
 * @param {object} spec { server, container?, engine, database, outputName?, scheduleId?, options? }
 *   `options` is passed through to steps (e.g. { compress: true, encrypt: true, destinations: [...] }).
 * @returns {Promise<object>} final context (ctx.file is the backup path)
 */
async function runBackup(job, spec) {
  const driver = getDriver(spec.engine, spec.server.kind)
  const target = { server: spec.server, container: spec.container }
  fs.mkdirSync(BACKUPS_DIR, { recursive: true })
  const name = spec.outputName || spec.database
  const file = path.join(BACKUPS_DIR, `${name}_${timestamp()}${driver.fileExtension}`)

  job.log(`[backup] ${driver.label} '${spec.database}' on ${spec.server.name}${spec.container ? ` / ${spec.container}` : ''}`)
  await driver.dump(job, target, { database: spec.database, outFile: file })

  let ctx = {
    file,
    engine: spec.engine,
    database: spec.database,
    server: spec.server,
    container: spec.container,
    scheduleId: spec.scheduleId,
    options: spec.options || {},
    compressed: false,
    encrypted: false,
    locations: [],
  }
  for (const step of postBackupSteps) {
    job.log(`[backup] step: ${step.name}`)
    ctx = (await step.fn(ctx, job)) || ctx
  }

  if (fs.existsSync(ctx.file)) {
    const stat = fs.statSync(ctx.file)
    catalog.recordBackup({
      filename: path.basename(ctx.file),
      engine: ctx.engine,
      serverId: ctx.server.id,
      container: ctx.container,
      sourceDatabase: ctx.database,
      jobId: job.id,
      scheduleId: ctx.scheduleId,
      size: stat.size,
      sha256: await sha256File(ctx.file),
      compressed: ctx.compressed,
      encrypted: ctx.encrypted,
      locations: ctx.locations,
    })
    job.meta.file = path.basename(ctx.file)
    job.log(`[backup] Saved ${path.basename(ctx.file)} (${stat.size} bytes)`)
  }
  return ctx
}

/**
 * Run a restore inside a job.
 * @param {object} spec { server, container?, engine, database, file, dropExisting? }
 *   `file` is a backup file name in BACKUPS_DIR.
 */
async function runRestore(job, spec) {
  const driver = getDriver(spec.engine, spec.server.kind)
  const target = { server: spec.server, container: spec.container }
  let ctx = {
    file: catalog.backupPath(spec.file),
    filename: spec.file,
    entry: catalog.getCatalogEntry(spec.file),
    engine: spec.engine,
    database: spec.database,
    server: spec.server,
    tempFiles: [],
  }
  try {
    for (const step of preRestoreSteps) {
      ctx = (await step.fn(ctx, job)) || ctx
    }
    if (!fs.existsSync(ctx.file)) throw new Error(`Backup file not found: ${spec.file}`)
    job.log(`[restore] ${driver.label} into '${spec.database}' on ${spec.server.name}${spec.container ? ` / ${spec.container}` : ''}`)
    await driver.restore(job, target, { database: spec.database, inFile: ctx.file, dropExisting: !!spec.dropExisting })
  } finally {
    for (const tmp of ctx.tempFiles) fs.rmSync(tmp, { force: true })
  }
  return ctx
}

module.exports = {
  registerPostBackupStep, registerPreRestoreStep, runBackup, runRestore, timestamp, sha256File,
}
