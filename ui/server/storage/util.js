const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { DATA_DIR } = require('../config')

// Shared helpers for the storage steps.

const GZ = '.gz'
const ENC = '.enc'

/**
 * Directory for temporary restore files. Lives in DATA_DIR (inside the
 * backups volume by default) so large dumps do not fill the container's /tmp.
 */
function tmpDir() {
  const dir = path.join(DATA_DIR, 'tmp')
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  return dir
}

/** Unique temporary file path ending with `suffix` (e.g. '.sql.gz'). */
function tempPath(suffix = '') {
  return path.join(tmpDir(), `${crypto.randomUUID()}${suffix}`)
}

/** 'db_x.sql.gz.enc' → 'db_x.sql' (removes our storage suffixes). */
function stripStorageSuffixes(name) {
  let base = String(name)
  if (base.toLowerCase().endsWith(ENC)) base = base.slice(0, -ENC.length)
  if (base.toLowerCase().endsWith(GZ)) base = base.slice(0, -GZ.length)
  return base
}

/** Suffix of `name` starting at the raw dump extension, e.g. '.sql.gz.enc'. */
function storageSuffix(name) {
  return String(name).match(/(\.[A-Za-z0-9]+)+$/)?.[0] || ''
}

function readHead(file, n) {
  const fd = fs.openSync(file, 'r')
  try {
    const buf = Buffer.alloc(n)
    return buf.subarray(0, fs.readSync(fd, buf, 0, n, 0))
  } finally {
    fs.closeSync(fd)
  }
}

/** Gzip streams start with 1f 8b. */
function isGzipFile(file) {
  const head = readHead(file, 2)
  return head.length === 2 && head[0] === 0x1f && head[1] === 0x8b
}

function errorMessage(err) {
  return err instanceof Error ? err.message : String(err)
}

module.exports = {
  GZ, ENC, tmpDir, tempPath, stripStorageSuffixes, storageSuffix, readHead, isGzipFile, errorMessage,
}
