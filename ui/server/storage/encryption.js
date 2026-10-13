const fs = require('fs')
const config = require('./config')
const { encryptFile, decryptFile, isEncryptedFile } = require('./crypto-format')
const { ENC, tempPath, storageSuffix } = require('./util')

// AES-256-GCM encryption of finished backups (post-backup, order 200) and
// decryption before restore (pre-restore, order 200). File format:
// crypto-format.js. Offline decryption: decrypt-cli.js.

/** options.encrypt (boolean) overrides the default from settings. */
function shouldEncrypt(options = {}) {
  if (options.encrypt === undefined) return config.getEncryption().enabled
  if (typeof options.encrypt !== 'boolean') throw new Error('options.encrypt must be a boolean')
  return options.encrypt
}

/** Post-backup step: db_x.sql.gz → db_x.sql.gz.enc */
async function encryptStep(ctx, job) {
  if (!shouldEncrypt(ctx.options) || ctx.encrypted) return ctx
  const passphrase = config.currentPassphrase()
  if (!passphrase) {
    throw new Error('Encryption was requested but no passphrase is configured (Settings → Storage or BACKUP_ENCRYPTION_PASSPHRASE)')
  }
  const out = ctx.file + ENC
  await encryptFile(ctx.file, out, passphrase)
  fs.rmSync(ctx.file, { force: true })
  job.log('[encrypt] AES-256-GCM encrypted (scrypt key derivation)')
  return { ...ctx, file: out, encrypted: true }
}

/**
 * Pre-restore step: decrypt into a temporary file. The temporary file is
 * only handed to the next step after the GCM tag has verified.
 */
async function decryptStep(ctx, job) {
  if (!fs.existsSync(ctx.file) || !isEncryptedFile(ctx.file)) return ctx
  const passphrases = config.candidatePassphrases()
  if (passphrases.length === 0) throw new Error('Backup is encrypted but no encryption passphrase is configured')
  const tmp = tempPath(storageSuffix(String(ctx.filename || '').replace(/\.enc$/i, '')))
  job.log('[restore] Decrypting backup (verifying authenticity)')
  await decryptFile(ctx.file, tmp, passphrases)
  job.log('[restore] Decryption verified')
  return { ...ctx, file: tmp, tempFiles: [...ctx.tempFiles, tmp] }
}

module.exports = { encryptStep, decryptStep, shouldEncrypt }
