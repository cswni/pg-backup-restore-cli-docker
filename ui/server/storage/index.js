const catalog = require('../catalog')
const pipeline = require('../pipeline')
const destinations = require('./destinations')
const { compressStep, decompressStep } = require('./compression')
const { encryptStep, decryptStep } = require('./encryption')
const { uploadStep, remoteDownloadStep } = require('./transfer')
const { retentionStep, startSweepTimer } = require('./retention')
const { router, publicRouter } = require('./routes')
const { stripStorageSuffixes } = require('./util')

// Storage module: compression, encryption, remote destinations (S3, Google
// Drive) and retention, all plugged into the backup/restore pipeline.
//
// Backup:  compress 100 → encrypt 200 → upload 300 → retention 900
// Restore: download 100 → decrypt 200 → decompress 300

/** Catalog pattern: <any backup name>.gz / .enc / .gz.enc */
const storageSuffixPattern = {
  test(name) {
    const base = stripStorageSuffixes(name)
    return base !== name && catalog.isBackupFile(base)
  },
}

let initialised = false

function init() {
  destinations.init()
  if (initialised) return
  initialised = true
  catalog.registerBackupPattern(storageSuffixPattern)
  pipeline.registerPostBackupStep('compress', 100, compressStep)
  pipeline.registerPostBackupStep('encrypt', 200, encryptStep)
  pipeline.registerPostBackupStep('upload', 300, uploadStep)
  pipeline.registerPostBackupStep('retention', 900, retentionStep)
  pipeline.registerPreRestoreStep('download', 100, remoteDownloadStep)
  pipeline.registerPreRestoreStep('decrypt', 200, decryptStep)
  pipeline.registerPreRestoreStep('decompress', 300, decompressStep)
  startSweepTimer()
}

module.exports = { init, router, publicRouter }
