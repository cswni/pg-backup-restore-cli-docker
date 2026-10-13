const fs = require('fs')
const zlib = require('zlib')
const { pipeline } = require('stream/promises')
const config = require('./config')
const { GZ, tempPath, isGzipFile, stripStorageSuffixes, storageSuffix } = require('./util')

// Streaming gzip compression (post-backup, order 100) and decompression
// (pre-restore, order 300).

/** Gzip `inFile` into `outFile`; removes the partial output on failure. */
async function gzipFile(inFile, outFile, level = 6) {
  try {
    await pipeline(fs.createReadStream(inFile), zlib.createGzip({ level }), fs.createWriteStream(outFile))
  } catch (err) {
    fs.rmSync(outFile, { force: true })
    throw err
  }
}

/** Gunzip `inFile` into `outFile`; removes the partial output on failure. */
async function gunzipFile(inFile, outFile) {
  try {
    await pipeline(fs.createReadStream(inFile), zlib.createGunzip(), fs.createWriteStream(outFile))
  } catch (err) {
    fs.rmSync(outFile, { force: true })
    throw err
  }
}

/** options.compress (boolean) overrides the default from settings. */
function shouldCompress(options = {}) {
  if (options.compress === undefined) return config.getCompression().enabled
  if (typeof options.compress !== 'boolean') throw new Error('options.compress must be a boolean')
  return options.compress
}

/** Post-backup step: db_x.sql → db_x.sql.gz */
async function compressStep(ctx, job) {
  if (!shouldCompress(ctx.options) || ctx.compressed) return ctx
  const { level } = config.getCompression()
  const out = ctx.file + GZ
  const before = fs.statSync(ctx.file).size
  await gzipFile(ctx.file, out, level)
  fs.rmSync(ctx.file, { force: true })
  const after = fs.statSync(out).size
  job.log(`[compress] gzip level ${level}: ${before} → ${after} bytes`)
  return { ...ctx, file: out, compressed: true }
}

/** Pre-restore step: decompress gzip input into a temporary file. */
async function decompressStep(ctx, job) {
  if (!fs.existsSync(ctx.file) || !isGzipFile(ctx.file)) return ctx
  const tmp = tempPath(storageSuffix(stripStorageSuffixes(ctx.filename || 'restore.sql')))
  job.log('[restore] Decompressing gzip backup')
  // Register the temp file first so it is cleaned up even if gunzip fails
  const next = { ...ctx, tempFiles: [...ctx.tempFiles, tmp] }
  await gunzipFile(ctx.file, tmp)
  return { ...next, file: tmp }
}

module.exports = { gzipFile, gunzipFile, compressStep, decompressStep, shouldCompress }
