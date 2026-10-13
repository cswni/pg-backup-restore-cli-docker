const fs = require('fs')
const express = require('express')
const { requireAdmin } = require('../auth')
const catalog = require('../catalog')
const { httpError } = require('../validation')
const { handle } = require('../routes/util')
const config = require('./config')
const destinations = require('./destinations')
const retention = require('./retention')
const { deleteLocation } = require('./transfer')
const oauth = require('./oauth')
const { errorMessage } = require('./util')

// /api/storage/* — storage settings, remote destinations, retention.
// Reads needed by the export modal are open to every signed-in user;
// everything else is admin-only.

const router = express.Router()

function validateName(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 100) {
    throw httpError(400, 'name is required (max 100 characters)')
  }
  return value.trim()
}

function optionalBool(value, field, fallback) {
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') throw httpError(400, `${field} must be a boolean`)
  return value
}

/** Validate a create/update payload into store fields. */
function destinationFields(body, type, current) {
  if (!body || typeof body !== 'object') throw httpError(400, 'Body must be an object')
  const provider = destinations.getProvider(type)
  return {
    type,
    name: validateName(body.name),
    enabled: optionalBool(body.enabled, 'enabled', current ? current.enabled : true),
    isDefault: optionalBool(body.isDefault, 'isDefault', current ? current.isDefault : false),
    config: provider.validateConfig(body.config || {}, current ? current.config : {}),
    retention: config.validateRetentionPolicy(body.retention ?? current?.retention, 'retention'),
  }
}

// ── Read endpoints (any signed-in user) ─────────────────────────────────────

router.get('/storage/defaults', handle(async (req, res) => {
  const enc = config.publicSettings().encryption
  res.json({
    compress: config.getCompression().enabled,
    encrypt: enc.enabled,
    encryptionAvailable: enc.passphraseConfigured,
    destinations: destinations.listDestinations()
      .filter((d) => d.enabled)
      .map(({ id, name, type, isDefault, config: c }) => ({
        id, name, type, isDefault, ready: type !== 'gdrive' || !!c.refreshToken,
      })),
  })
}))

router.get('/storage/destinations', handle(async (req, res) => {
  const list = destinations.listDestinations()
  if (req.user?.role === 'admin') return res.json(list.map(destinations.maskDestination))
  res.json(list.map(({ id, name, type, enabled, isDefault }) => ({ id, name, type, enabled, isDefault })))
}))

// ── Admin endpoints ──────────────────────────────────────────────────────────

router.get('/storage/settings', requireAdmin, handle(async (req, res) => {
  res.json({ ...config.publicSettings(), gdriveRedirectUri: oauth.redirectUri(req) })
}))

router.put('/storage/settings', requireAdmin, handle(async (req, res) => {
  res.json({ ...config.saveSettings(req.body), gdriveRedirectUri: oauth.redirectUri(req) })
}))

router.post('/storage/destinations', requireAdmin, handle(async (req, res) => {
  const type = req.body?.type
  if (!destinations.TYPES.includes(type)) throw httpError(400, `type must be one of: ${destinations.TYPES.join(', ')}`)
  const dest = destinations.insertDestination(destinationFields(req.body, type, null))
  res.status(201).json(destinations.maskDestination(dest))
}))

router.put('/storage/destinations/:id', requireAdmin, handle(async (req, res) => {
  const current = destinations.requireDestination(req.params.id)
  const dest = destinations.updateDestination(current.id, destinationFields(req.body, current.type, current))
  res.json(destinations.maskDestination(dest))
}))

function localExists(filename) {
  try { return fs.existsSync(catalog.backupPath(filename)) } catch { return false }
}

/** Drop catalog references to a deleted destination (copies there become unmanaged). */
function forgetDestination(id) {
  for (const entry of catalog.listCatalogEntries()) {
    if (!entry.locations.some((l) => l.destinationId === id)) continue
    const locations = entry.locations.filter((l) => l.destinationId !== id)
    if (locations.length === 0 && !localExists(entry.filename)) catalog.removeCatalogEntry(entry.filename)
    else catalog.updateLocations(entry.filename, locations)
  }
}

router.delete('/storage/destinations/:id', requireAdmin, handle(async (req, res) => {
  const dest = destinations.requireDestination(req.params.id)
  destinations.deleteDestination(dest.id)
  forgetDestination(dest.id)
  res.json({ ok: true })
}))

router.post('/storage/destinations/:id/test', requireAdmin, handle(async (req, res) => {
  const dest = destinations.requireDestination(req.params.id)
  try {
    res.json(await destinations.getProvider(dest.type).test(dest))
  } catch (err) {
    res.json({ ok: false, message: errorMessage(err) })
  }
}))

router.post('/storage/retention/run', requireAdmin, handle(async (req, res) => {
  const jobId = retention.startSweep('manual', req.user?.username)
  if (!jobId) throw httpError(400, 'No retention policy is configured')
  res.json({ jobId })
}))

// Delete every remote copy of a backup; the catalog row goes away when no
// local file remains either.
router.delete('/storage/backups/:filename/remote', requireAdmin, handle(async (req, res) => {
  catalog.backupPath(req.params.filename) // validates the name
  const entry = catalog.getCatalogEntry(req.params.filename)
  if (!entry || entry.locations.length === 0) throw httpError(404, 'No remote copies recorded for this backup')
  const failed = []
  for (const loc of entry.locations) {
    try { await deleteLocation(loc) } catch (err) { failed.push({ ...loc, error: errorMessage(err) }) }
  }
  const remaining = entry.locations.filter((l) => failed.some((f) => f.destinationId === l.destinationId))
  if (remaining.length === 0 && !localExists(entry.filename)) catalog.removeCatalogEntry(entry.filename)
  else catalog.updateLocations(entry.filename, remaining)
  if (failed.length) throw httpError(502, `Could not delete: ${failed.map((f) => f.error).join('; ')}`)
  res.json({ ok: true })
}))

router.use(oauth.router)

module.exports = { router, publicRouter: oauth.publicRouter }
