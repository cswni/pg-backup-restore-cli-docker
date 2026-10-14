const settings = require('../settings')
const { httpError } = require('../validation')

// Storage settings (compression, encryption, upload policy, local retention)
// persisted in the shared settings store under `storage.*` keys.

const KEYS = {
  compression: 'storage.compression',
  encryption: 'storage.encryption',
  upload: 'storage.upload',
  retention: 'storage.retention',
  passphrase: 'storage.encryption.passphrase',
  previous: 'storage.encryption.previousPassphrases',
}

const DEFAULTS = Object.freeze({
  compression: { enabled: true, level: 6 },
  encryption: { enabled: false },
  upload: { failurePolicy: 'fail' },
  retention: { local: { keepLast: null, keepDays: null } },
})

const MIN_PASSPHRASE = 12
const MAX_KEEP = 100000

function getCompression() {
  return { ...DEFAULTS.compression, ...settings.getSetting(KEYS.compression, {}) }
}

function getEncryption() {
  return { ...DEFAULTS.encryption, ...settings.getSetting(KEYS.encryption, {}) }
}

function getUploadPolicy() {
  return { ...DEFAULTS.upload, ...settings.getSetting(KEYS.upload, {}) }
}

function getLocalRetention() {
  return { ...DEFAULTS.retention.local, ...settings.getSetting(KEYS.retention, {}).local }
}

/** Passphrase used for new backups: env BACKUP_ENCRYPTION_PASSPHRASE wins over the stored one. */
function currentPassphrase() {
  return process.env.BACKUP_ENCRYPTION_PASSPHRASE || settings.getSecret(KEYS.passphrase) || null
}

/** Every passphrase worth trying when decrypting (current first, then older ones). */
function candidatePassphrases() {
  const list = [
    process.env.BACKUP_ENCRYPTION_PASSPHRASE,
    settings.getSecret(KEYS.passphrase),
    ...(settings.getSecret(KEYS.previous) || []),
  ].filter(Boolean)
  return [...new Set(list)]
}

function passphraseSource() {
  if (process.env.BACKUP_ENCRYPTION_PASSPHRASE) return 'env'
  return settings.hasSecret(KEYS.passphrase) ? 'settings' : null
}

/** Settings as returned to the (admin) UI. Never includes passphrases. */
function publicSettings() {
  return {
    compression: getCompression(),
    encryption: {
      ...getEncryption(),
      passphraseConfigured: !!currentPassphrase(),
      passphraseSource: passphraseSource(),
      previousPassphrases: (settings.getSecret(KEYS.previous) || []).length,
    },
    upload: getUploadPolicy(),
    retention: { local: getLocalRetention() },
  }
}

function optionalBool(value, field) {
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') throw httpError(400, `${field} must be a boolean`)
  return value
}

/** null/''/0 → null (rule disabled), otherwise a positive integer ≤ max. */
function optionalCount(value, field, max = MAX_KEEP) {
  if (value === null || value === '' || value === 0 || value === undefined) return null
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw httpError(400, `${field} must be an integer between 1 and ${max}, or null`)
  }
  return value
}

/** Validate a { keepLast, keepDays } policy object. */
function validateRetentionPolicy(policy, field) {
  if (policy == null) return { keepLast: null, keepDays: null }
  if (typeof policy !== 'object' || Array.isArray(policy)) throw httpError(400, `${field} must be an object`)
  return {
    keepLast: optionalCount(policy.keepLast, `${field}.keepLast`),
    keepDays: optionalCount(policy.keepDays, `${field}.keepDays`, 36500),
  }
}

function buildCompression(input) {
  const enabled = optionalBool(input.enabled, 'compression.enabled')
  const level = input.level
  if (level !== undefined && (!Number.isInteger(level) || level < 1 || level > 9)) {
    throw httpError(400, 'compression.level must be an integer between 1 and 9')
  }
  const current = getCompression()
  return { enabled: enabled ?? current.enabled, level: level ?? current.level }
}

function validatePassphrase(passphrase) {
  if (passphrase === undefined || passphrase === '') return null
  if (typeof passphrase !== 'string' || passphrase.length < MIN_PASSPHRASE || passphrase.length > 1024) {
    throw httpError(400, `encryption.passphrase must be ${MIN_PASSPHRASE}-1024 characters`)
  }
  return passphrase
}

function buildEncryption(input) {
  const enabled = optionalBool(input.enabled, 'encryption.enabled') ?? getEncryption().enabled
  const passphrase = validatePassphrase(input.passphrase)
  if (enabled && !passphrase && !currentPassphrase()) {
    throw httpError(400, 'Set an encryption passphrase before enabling encryption')
  }
  return { value: { enabled }, passphrase }
}

function buildUpload(input) {
  if (!['fail', 'best-effort'].includes(input.failurePolicy)) {
    throw httpError(400, "upload.failurePolicy must be 'fail' or 'best-effort'")
  }
  return { failurePolicy: input.failurePolicy }
}

function savePassphrase(passphrase) {
  const old = settings.getSecret(KEYS.passphrase)
  if (old && old !== passphrase) {
    // Old backups stay decryptable: keep every replaced passphrase.
    const previous = settings.getSecret(KEYS.previous) || []
    settings.setSecret(KEYS.previous, [old, ...previous.filter((p) => p !== old)])
  }
  settings.setSecret(KEYS.passphrase, passphrase)
}

function assertObject(value, field) {
  if (value !== undefined && (typeof value !== 'object' || value === null || Array.isArray(value))) {
    throw httpError(400, `${field} must be an object`)
  }
}

/**
 * Validate and persist a partial settings update. Every section is
 * validated before anything is written.
 * @param {object} body  { compression?, encryption?: { enabled?, passphrase? }, upload?, retention? }
 * @returns {object} publicSettings()
 */
function saveSettings(body) {
  assertObject(body ?? null, 'body')
  for (const k of ['compression', 'encryption', 'upload', 'retention']) assertObject(body[k], k)
  const compression = body.compression && buildCompression(body.compression)
  const encryption = body.encryption && buildEncryption(body.encryption)
  const upload = body.upload && buildUpload(body.upload)
  const retention = body.retention && { local: validateRetentionPolicy(body.retention.local, 'retention.local') }

  if (compression) settings.setSetting(KEYS.compression, compression)
  if (upload) settings.setSetting(KEYS.upload, upload)
  if (retention) settings.setSetting(KEYS.retention, retention)
  if (encryption?.passphrase) savePassphrase(encryption.passphrase)
  if (encryption) settings.setSetting(KEYS.encryption, encryption.value)
  return publicSettings()
}

module.exports = {
  getCompression, getEncryption, getUploadPolicy, getLocalRetention,
  currentPassphrase, candidatePassphrases, publicSettings, saveSettings,
  validateRetentionPolicy, MIN_PASSPHRASE,
}
