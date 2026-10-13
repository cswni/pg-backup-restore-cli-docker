const fs = require('fs')
const path = require('path')
const catalog = require('../catalog')
const { sha256File } = require('../pipeline')
const config = require('./config')
const destinations = require('./destinations')
const { tempPath, storageSuffix, errorMessage } = require('./util')

// Copies to remote destinations: post-backup upload (order 300) and the
// pre-restore download of remote-only backups (order 100).

/**
 * Destinations for a backup: `options.destinations` (array of ids) when
 * given, otherwise every enabled destination marked as default.
 */
function selectDestinations(options = {}) {
  if (options.destinations === undefined) {
    return destinations.listDestinations().filter((d) => d.enabled && d.isDefault)
  }
  if (!Array.isArray(options.destinations) || options.destinations.some((id) => typeof id !== 'string')) {
    throw new Error('options.destinations must be an array of destination ids')
  }
  return [...new Set(options.destinations)].map((id) => {
    const dest = destinations.getDestination(id)
    if (!dest) throw new Error(`Unknown destination: ${id}`)
    if (!dest.enabled) throw new Error(`Destination '${dest.name}' is disabled`)
    return dest
  })
}

async function uploadOne(dest, file, job) {
  const started = Date.now()
  job.log(`[upload] → ${dest.name} (${dest.type})…`)
  const result = await destinations.getProvider(dest.type).upload(dest, file, path.basename(file))
  job.log(`[upload] ✓ ${dest.name} in ${((Date.now() - started) / 1000).toFixed(1)}s`)
  return { destinationId: dest.id, type: dest.type, ...result, uploadedAt: Date.now() }
}

/** Record the catalog row before failing so successful copies are not lost. */
async function recordPartial(ctx, job, locations) {
  const stat = fs.statSync(ctx.file)
  catalog.recordBackup({
    filename: path.basename(ctx.file),
    engine: ctx.engine,
    serverId: ctx.server?.id,
    container: ctx.container,
    sourceDatabase: ctx.database,
    jobId: job.id,
    scheduleId: ctx.scheduleId,
    size: stat.size,
    sha256: await sha256File(ctx.file),
    compressed: ctx.compressed,
    encrypted: ctx.encrypted,
    locations,
  })
}

/** Post-backup step: upload the final file to the selected destinations. */
async function uploadStep(ctx, job) {
  const targets = selectDestinations(ctx.options)
  if (targets.length === 0) return ctx
  const locations = [...ctx.locations]
  const failures = []
  for (const dest of targets) {
    try {
      locations.push(await uploadOne(dest, ctx.file, job))
    } catch (err) {
      failures.push(dest.name)
      job.log(`[upload] ✗ ${dest.name}: ${errorMessage(err)}`, 'stderr')
    }
  }
  if (failures.length > 0) {
    const { failurePolicy } = config.getUploadPolicy()
    if (failurePolicy !== 'best-effort') {
      await recordPartial(ctx, job, locations)
      throw new Error(`Upload failed for: ${failures.join(', ')} (the local backup was kept)`)
    }
    job.log(`[upload] WARNING: continuing without copies on ${failures.join(', ')} (best-effort policy)`, 'stderr')
  }
  return { ...ctx, locations }
}

/**
 * Download a backup from the first reachable remote copy into `outFile`.
 * Verifies the SHA-256 recorded in the catalog when present.
 */
async function downloadFromLocations(entry, outFile, job) {
  const errors = []
  for (const loc of entry.locations) {
    const dest = destinations.getDestination(loc.destinationId)
    if (!dest || !dest.enabled) continue
    try {
      job.log(`[restore] Downloading ${entry.filename} from ${dest.name} (${dest.type})…`)
      await destinations.getProvider(dest.type).download(dest, loc, outFile)
      if (entry.sha256 && (await sha256File(outFile)) !== entry.sha256) {
        fs.rmSync(outFile, { force: true })
        throw new Error('checksum mismatch')
      }
      job.log(`[restore] Downloaded ${fs.statSync(outFile).size} bytes, checksum verified`)
      return dest
    } catch (err) {
      errors.push(`${dest.name}: ${errorMessage(err)}`)
      job.log(`[restore] ✗ ${dest.name}: ${errorMessage(err)}`, 'stderr')
    }
  }
  throw new Error(`Could not download ${entry.filename} from any remote copy${errors.length ? ` (${errors.join('; ')})` : ''}`)
}

/** Pre-restore step: fetch remote-only backups into a temporary file. */
async function remoteDownloadStep(ctx, job) {
  if (fs.existsSync(ctx.file)) return ctx
  const entry = ctx.entry
  if (!entry?.locations?.length) return ctx
  const tmp = tempPath(storageSuffix(ctx.filename))
  const next = { ...ctx, tempFiles: [...ctx.tempFiles, tmp] }
  await downloadFromLocations(entry, tmp, job)
  return { ...next, file: tmp }
}

/**
 * Delete one remote copy. Unknown destinations (already deleted) count as
 * gone. Returns true when the copy no longer exists.
 */
async function deleteLocation(loc) {
  const dest = destinations.getDestination(loc.destinationId)
  if (!dest) return true
  await destinations.getProvider(dest.type).remove(dest, loc)
  return true
}

module.exports = {
  uploadStep, remoteDownloadStep, selectDestinations, downloadFromLocations, deleteLocation,
}
