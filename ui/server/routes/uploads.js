const fs = require('fs')
const path = require('path')
const { randomUUID } = require('crypto')
const { pipeline } = require('stream/promises')
const express = require('express')
const { BACKUPS_DIR } = require('../config')
const { isBackupFile } = require('../catalog')
const { handle } = require('./util')
const { httpError } = require('../validation')
const { startRestoreJob, assertCanRun } = require('./ops')

// Chunked, resumable uploads.
//
// A single multipart request fails behind proxies with body limits
// (Cloudflare: 100 MB) and long-request timeouts, so the browser sends the
// file in CHUNK_SIZE pieces:
//   POST   /api/uploads                { filename, size }        → { uploadId, chunkSize }
//   PUT    /api/uploads/:id?offset=N   raw bytes (≤ MAX_CHUNK)   → { received }
//   GET    /api/uploads/:id                                      → { received, size }
//   POST   /api/uploads/:id/complete   { restore?, … }           → { filename, jobId? }
//   DELETE /api/uploads/:id                                      → cancel
// Parts live in BACKUPS_DIR/.uploads (same filesystem → atomic rename).

const CHUNK_SIZE = 8 * 1024 * 1024
const MAX_CHUNK = 16 * 1024 * 1024
const STALE_MS = 24 * 60 * 60 * 1000
const UPLOAD_DIR = path.join(BACKUPS_DIR, '.uploads')
const ID_RE = /^[0-9a-f-]{36}$/

const router = express.Router()

function paths(id) {
  if (!ID_RE.test(id)) throw httpError(400, 'Invalid upload id')
  return { partFile: path.join(UPLOAD_DIR, `${id}.part`), metaFile: path.join(UPLOAD_DIR, `${id}.json`) }
}

function readUpload(id) {
  const p = paths(id)
  if (!fs.existsSync(p.metaFile)) throw httpError(404, 'Upload not found or expired')
  const meta = JSON.parse(fs.readFileSync(p.metaFile, 'utf8'))
  const received = fs.existsSync(p.partFile) ? fs.statSync(p.partFile).size : 0
  return { ...p, meta, received }
}

/** Unique destination name in BACKUPS_DIR (never overwrite an existing backup). */
function uniqueName(filename) {
  if (!fs.existsSync(path.join(BACKUPS_DIR, filename))) return filename
  const ext = filename.match(/(\.[a-z0-9]+)+$/i)?.[0] || ''
  return `${filename.slice(0, filename.length - ext.length)}_upload_${Date.now()}${ext}`
}

function cleanupStale() {
  if (!fs.existsSync(UPLOAD_DIR)) return
  const now = Date.now()
  for (const f of fs.readdirSync(UPLOAD_DIR)) {
    const full = path.join(UPLOAD_DIR, f)
    if (now - fs.statSync(full).mtimeMs > STALE_MS) fs.rmSync(full, { force: true })
  }
}

router.post('/uploads', handle(async (req, res) => {
  const { filename, size } = req.body ?? {}
  const name = path.basename(String(filename || ''))
  if (!name || name !== filename || !isBackupFile(name)) throw httpError(400, `Unsupported backup file name: ${filename}`)
  if (!Number.isSafeInteger(size) || size <= 0) throw httpError(400, 'size must be a positive integer')

  fs.mkdirSync(UPLOAD_DIR, { recursive: true })
  const id = randomUUID()
  const p = paths(id)
  fs.writeFileSync(p.metaFile, JSON.stringify({ filename: name, size, createdAt: Date.now(), username: req.user?.username }))
  fs.writeFileSync(p.partFile, '')
  res.json({ uploadId: id, chunkSize: CHUNK_SIZE })
}))

router.get('/uploads/:id', handle(async (req, res) => {
  const u = readUpload(req.params.id)
  res.json({ received: u.received, size: u.meta.size })
}))

router.put('/uploads/:id', handle(async (req, res) => {
  const u = readUpload(req.params.id)
  const offset = Number(req.query.offset)
  // Offset must match what we already have, so retries never duplicate bytes
  if (offset !== u.received) {
    return res.status(409).json({ error: 'Offset mismatch', received: u.received })
  }
  const length = Number(req.headers['content-length'])
  if (!Number.isFinite(length) || length <= 0 || length > MAX_CHUNK) throw httpError(413, `Chunk must be 1..${MAX_CHUNK} bytes`)
  if (u.received + length > u.meta.size) throw httpError(400, 'Chunk exceeds declared file size')

  // An aborted request may leave a partial chunk; the client re-syncs via
  // GET /uploads/:id (or the 409 above) and resumes from `received`.
  await pipeline(req, fs.createWriteStream(u.partFile, { flags: 'a' }))
  res.json({ received: fs.statSync(u.partFile).size })
}))

router.post('/uploads/:id/complete', handle(async (req, res) => {
  // Check before completing so a refused restore leaves the upload resumable
  if (req.body?.restore) assertCanRun('restore', req.user)
  const u = readUpload(req.params.id)
  if (u.received !== u.meta.size) throw httpError(409, `Upload incomplete: ${u.received}/${u.meta.size} bytes`)

  const filename = uniqueName(u.meta.filename)
  fs.renameSync(u.partFile, path.join(BACKUPS_DIR, filename))
  fs.rmSync(u.metaFile, { force: true })

  const { restore, ...spec } = req.body ?? {}
  if (restore) {
    try {
      const jobId = startRestoreJob({ ...spec, file: filename }, req.user)
      return res.json({ ok: true, filename, jobId })
    } catch (err) {
      // The file is saved even if the restore could not start
      return res.status(err.status || 500).json({ error: err.message, filename })
    }
  }
  res.json({ ok: true, filename })
}))

router.delete('/uploads/:id', handle(async (req, res) => {
  const p = paths(req.params.id)
  fs.rmSync(p.partFile, { force: true })
  fs.rmSync(p.metaFile, { force: true })
  res.json({ ok: true })
}))

function init() {
  cleanupStale()
  setInterval(cleanupStale, 60 * 60 * 1000).unref()
}

module.exports = { router, init, CHUNK_SIZE }
