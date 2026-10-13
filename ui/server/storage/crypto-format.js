const crypto = require('crypto')
const fs = require('fs')
const { Readable, Transform } = require('stream')
const { pipeline } = require('stream/promises')

// Encrypted backup file format, version 1 ("PGBKENC").
//
// Self-contained on purpose: depends only on Node core so the offline
// decryption CLI (decrypt-cli.js) works without the web server, database
// or node_modules.
//
//   offset  size  field
//   0       7     magic "PGBKENC"
//   7       1     format version (1)
//   8       1     KDF id (1 = scrypt)
//   9       1     scrypt log2(N)
//   10      1     scrypt r
//   11      1     scrypt p
//   12      16    salt (random per file)
//   28      12    AES-GCM nonce (random per file)
//   40      16    key check (lets a wrong passphrase fail fast)
//   56      …     AES-256-GCM ciphertext
//   end-16  16    GCM authentication tag
//
// scrypt(passphrase, salt, 48) → 32-byte AES key + 16-byte key check.
// The whole 56-byte header is authenticated as GCM additional data, so any
// change to header, ciphertext or tag makes decryption fail.

const MAGIC = Buffer.from('PGBKENC', 'ascii')
const VERSION = 1
const KDF_SCRYPT = 1
const HEADER_SIZE = 56
const TAG_SIZE = 16
const SCRYPT = { logN: 15, r: 8, p: 1 }
// AES-GCM limit for a single (key, nonce) pair: 2^39 - 256 bits.
const MAX_PLAINTEXT = 2 ** 36 - 32

/** scrypt (async, off the event loop) → { key, check }. */
function deriveKeys(passphrase, salt, { logN, r, p }) {
  const N = 2 ** logN
  return new Promise((resolve, reject) => {
    crypto.scrypt(String(passphrase).normalize('NFKC'), salt, 48, { N, r, p, maxmem: 256 * N * r + 1024 * 1024 },
      (err, out) => (err ? reject(err) : resolve({ key: out.subarray(0, 32), check: out.subarray(32, 48) })))
  })
}

function buildHeader(salt, nonce, check, params = SCRYPT) {
  return Buffer.concat([
    MAGIC, Buffer.from([VERSION, KDF_SCRYPT, params.logN, params.r, params.p]), salt, nonce, check,
  ])
}

/** Parse and validate a header buffer. Throws on anything unexpected. */
function parseHeader(buf) {
  if (buf.length < HEADER_SIZE || !buf.subarray(0, 7).equals(MAGIC)) {
    throw new Error('Not an encrypted backup (bad magic)')
  }
  if (buf[7] !== VERSION) throw new Error(`Unsupported encrypted backup version ${buf[7]}`)
  if (buf[8] !== KDF_SCRYPT) throw new Error(`Unsupported key derivation function ${buf[8]}`)
  const params = { logN: buf[9], r: buf[10], p: buf[11] }
  if (params.logN < 10 || params.logN > 22 || params.r < 1 || params.r > 32 || params.p < 1 || params.p > 16) {
    throw new Error('Invalid key derivation parameters')
  }
  return {
    header: buf.subarray(0, HEADER_SIZE),
    params,
    salt: buf.subarray(12, 28),
    nonce: buf.subarray(28, 40),
    check: buf.subarray(40, 56),
  }
}

/** True when the file starts with the encrypted-backup magic. */
function isEncryptedFile(file) {
  const fd = fs.openSync(file, 'r')
  try {
    const buf = Buffer.alloc(MAGIC.length)
    const n = fs.readSync(fd, buf, 0, buf.length, 0)
    return n === MAGIC.length && buf.equals(MAGIC)
  } finally {
    fs.closeSync(fd)
  }
}

/**
 * Encrypt `inFile` into `outFile` (streaming). Removes `outFile` on failure.
 * @param {string} inFile
 * @param {string} outFile
 * @param {string} passphrase
 */
async function encryptFile(inFile, outFile, passphrase) {
  if (!passphrase) throw new Error('Encryption passphrase is empty')
  if (fs.statSync(inFile).size > MAX_PLAINTEXT) throw new Error('File too large for a single AES-GCM stream (64 GiB)')
  const salt = crypto.randomBytes(16)
  const nonce = crypto.randomBytes(12)
  const { key, check } = await deriveKeys(passphrase, salt, SCRYPT)
  const header = buildHeader(salt, nonce, check)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce)
  cipher.setAAD(header)
  // Appends the GCM tag once the cipher has flushed its last block
  const appendTag = new Transform({
    transform(chunk, enc, cb) { cb(null, chunk) },
    flush(cb) { cb(null, cipher.getAuthTag()) },
  })
  try {
    await pipeline(fs.createReadStream(inFile), cipher, appendTag, prefixWith(header),
      fs.createWriteStream(outFile, { mode: 0o600 }))
  } catch (err) {
    fs.rmSync(outFile, { force: true })
    throw err
  }
}

/** Transform that emits `prefix` before the first byte of its input. */
function prefixWith(prefix) {
  let sent = false
  const emit = (t) => { if (!sent) { sent = true; t.push(prefix) } }
  return new Transform({
    transform(chunk, enc, cb) { emit(this); cb(null, chunk) },
    flush(cb) { emit(this); cb() },
  })
}

function readRange(file, position, length) {
  const fd = fs.openSync(file, 'r')
  try {
    const buf = Buffer.alloc(length)
    const n = fs.readSync(fd, buf, 0, length, position)
    return buf.subarray(0, n)
  } finally {
    fs.closeSync(fd)
  }
}

/**
 * Find the passphrase (of several candidates) that matches the file's key
 * check. Returns the derived AES key or throws.
 */
async function keyForFile(parsed, passphrases) {
  for (const pass of passphrases.filter(Boolean)) {
    const { key, check } = await deriveKeys(pass, parsed.salt, parsed.params)
    if (crypto.timingSafeEqual(check, parsed.check)) return key
  }
  throw new Error('Wrong passphrase: none of the configured passphrases can decrypt this backup')
}

/**
 * Decrypt `inFile` into `outFile` (streaming). `outFile` is only left in
 * place when the GCM tag verifies; on any failure it is removed.
 * @param {string} inFile
 * @param {string} outFile
 * @param {string|string[]} passphrases  candidates, tried in order
 */
async function decryptFile(inFile, outFile, passphrases) {
  const size = fs.statSync(inFile).size
  if (size < HEADER_SIZE + TAG_SIZE) throw new Error('Encrypted backup is truncated')
  const parsed = parseHeader(readRange(inFile, 0, HEADER_SIZE))
  const key = await keyForFile(parsed, [].concat(passphrases))
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, parsed.nonce)
  decipher.setAAD(parsed.header)
  decipher.setAuthTag(readRange(inFile, size - TAG_SIZE, TAG_SIZE))
  const body = size - TAG_SIZE > HEADER_SIZE
    ? fs.createReadStream(inFile, { start: HEADER_SIZE, end: size - TAG_SIZE - 1 })
    : Readable.from([])
  try {
    await pipeline(body, decipher, fs.createWriteStream(outFile, { mode: 0o600 }))
  } catch (err) {
    fs.rmSync(outFile, { force: true })
    if (/unable to authenticate|auth/i.test(err.message)) {
      throw new Error('Encrypted backup failed authentication (corrupted or tampered file)')
    }
    throw err
  }
}

module.exports = {
  encryptFile, decryptFile, isEncryptedFile, parseHeader, HEADER_SIZE, TAG_SIZE, MAGIC,
}
