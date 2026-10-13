const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const { DATA_DIR } = require('./config')

// Encrypts credentials stored in the database (DB passwords, SSH keys,
// cloud tokens) with AES-256-GCM. The key comes from APP_SECRET, or from a
// generated key file in DATA_DIR when APP_SECRET is not set.
const PREFIX = 'enc:v1:'

let key = null

function loadKey() {
  if (key) return key
  if (process.env.APP_SECRET) {
    key = crypto.createHash('sha256').update(process.env.APP_SECRET).digest()
    return key
  }
  const file = path.join(DATA_DIR, 'secret.key')
  if (!fs.existsSync(file)) {
    fs.mkdirSync(DATA_DIR, { recursive: true })
    fs.writeFileSync(file, crypto.randomBytes(32).toString('base64'), { mode: 0o600 })
    console.warn(`[pg-backup-ui] APP_SECRET not set — generated encryption key at ${file}. Set APP_SECRET to keep secrets portable.`)
  }
  key = Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'base64')
  return key
}

function encrypt(plaintext) {
  if (plaintext == null || plaintext === '') return plaintext
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', loadKey(), iv)
  const data = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()])
  return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64')
}

function decrypt(value) {
  if (value == null || value === '' || !String(value).startsWith(PREFIX)) return value
  const raw = Buffer.from(String(value).slice(PREFIX.length), 'base64')
  const decipher = crypto.createDecipheriv('aes-256-gcm', loadKey(), raw.subarray(0, 12))
  decipher.setAuthTag(raw.subarray(12, 28))
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8')
}

/** Test helper. */
function setKeyForTests(secret) {
  key = crypto.createHash('sha256').update(secret).digest()
}

module.exports = { encrypt, decrypt, setKeyForTests }
