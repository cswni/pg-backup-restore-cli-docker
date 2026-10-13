const crypto = require('crypto')
const { getDb, migrate } = require('../../db')
const { encrypt, decrypt } = require('../../secrets')
const { httpError } = require('../../validation')
const { validateRetentionPolicy } = require('../config')

// Remote backup destinations (S3-compatible buckets, Google Drive).
// `config` is JSON; fields listed in SECRET_FIELDS are stored encrypted
// with secrets.encrypt() and never leave the server.

const SECRET_FIELDS = {
  s3: ['secretAccessKey'],
  gdrive: ['clientSecret', 'refreshToken'],
}
const TYPES = Object.keys(SECRET_FIELDS)

function init() {
  migrate('storage-001-destinations', `
    CREATE TABLE storage_destinations (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      name TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      is_default INTEGER NOT NULL DEFAULT 0,
      config TEXT NOT NULL DEFAULT '{}',
      retention TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `)
  migrate('storage-002-oauth-states', `
    CREATE TABLE storage_oauth_states (
      state TEXT PRIMARY KEY,
      destination_id TEXT NOT NULL,
      username TEXT,
      redirect_uri TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );
  `)
}

/** Decrypt secret fields: full config for server-side use only. */
function rowToDestination(row) {
  const stored = JSON.parse(row.config || '{}')
  const config = { ...stored }
  for (const f of SECRET_FIELDS[row.type] || []) if (stored[f]) config[f] = decrypt(stored[f])
  return {
    id: row.id,
    type: row.type,
    name: row.name,
    enabled: !!row.enabled,
    isDefault: !!row.is_default,
    config,
    retention: { keepLast: null, keepDays: null, ...JSON.parse(row.retention || '{}') },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/** Safe representation for the browser: secrets become `secrets.<field>: true|false`. */
function maskDestination(dest) {
  const secretFields = SECRET_FIELDS[dest.type] || []
  const config = Object.fromEntries(Object.entries(dest.config).filter(([k]) => !secretFields.includes(k)))
  const secrets = Object.fromEntries(secretFields.map((f) => [f, !!dest.config[f]]))
  return { ...dest, config, secrets }
}

function listDestinations() {
  return getDb().prepare('SELECT * FROM storage_destinations ORDER BY created_at').all().map(rowToDestination)
}

function getDestination(id) {
  const row = getDb().prepare('SELECT * FROM storage_destinations WHERE id = ?').get(String(id))
  return row ? rowToDestination(row) : null
}

function requireDestination(id) {
  const dest = getDestination(id)
  if (!dest) throw httpError(404, `Unknown destination: ${id}`)
  return dest
}

function encryptConfig(type, config) {
  const out = { ...config }
  for (const f of SECRET_FIELDS[type]) if (out[f]) out[f] = encrypt(out[f])
  return JSON.stringify(out)
}

/**
 * Insert a destination. `config` must already be validated by the provider.
 * @returns {object} the stored destination (unmasked)
 */
function insertDestination({ type, name, enabled = true, isDefault = false, config, retention }) {
  if (!TYPES.includes(type)) throw httpError(400, `type must be one of: ${TYPES.join(', ')}`)
  const id = crypto.randomUUID()
  const now = Date.now()
  getDb().prepare(`
    INSERT INTO storage_destinations (id, type, name, enabled, is_default, config, retention, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, type, name, enabled ? 1 : 0, isDefault ? 1 : 0, encryptConfig(type, config),
    JSON.stringify(validateRetentionPolicy(retention, 'retention')), now, now)
  return getDestination(id)
}

/** Replace the mutable fields of a destination (type never changes). */
function updateDestination(id, { name, enabled, isDefault, config, retention }) {
  const current = requireDestination(id)
  getDb().prepare(`
    UPDATE storage_destinations
    SET name = ?, enabled = ?, is_default = ?, config = ?, retention = ?, updated_at = ?
    WHERE id = ?
  `).run(name, enabled ? 1 : 0, isDefault ? 1 : 0, encryptConfig(current.type, config),
    JSON.stringify(validateRetentionPolicy(retention, 'retention')), Date.now(), id)
  return getDestination(id)
}

/** Merge new config values into a destination (e.g. a fresh OAuth refresh token). */
function patchConfig(id, patch) {
  const current = requireDestination(id)
  getDb().prepare('UPDATE storage_destinations SET config = ?, updated_at = ? WHERE id = ?')
    .run(encryptConfig(current.type, { ...current.config, ...patch }), Date.now(), id)
  return getDestination(id)
}

function deleteDestination(id) {
  requireDestination(id)
  getDb().prepare('DELETE FROM storage_destinations WHERE id = ?').run(id)
  getDb().prepare('DELETE FROM storage_oauth_states WHERE destination_id = ?').run(id)
}

// ── OAuth state (Google Drive connect flow) ──────────────────────────────────

const STATE_TTL_MS = 10 * 60 * 1000

/** Create a single-use, expiring OAuth state bound to destination + user. */
function createOAuthState({ destinationId, username, redirectUri }) {
  const state = crypto.randomBytes(32).toString('base64url')
  const db = getDb()
  db.prepare('DELETE FROM storage_oauth_states WHERE expires_at < ?').run(Date.now())
  db.prepare(`
    INSERT INTO storage_oauth_states (state, destination_id, username, redirect_uri, expires_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(state, destinationId, username || null, redirectUri, Date.now() + STATE_TTL_MS)
  return state
}

/** Look up and delete (single use) an OAuth state. Returns null when unknown or expired. */
function consumeOAuthState(state) {
  if (typeof state !== 'string' || !/^[A-Za-z0-9_-]{20,100}$/.test(state)) return null
  const db = getDb()
  const row = db.prepare('SELECT * FROM storage_oauth_states WHERE state = ?').get(state)
  if (!row) return null
  db.prepare('DELETE FROM storage_oauth_states WHERE state = ?').run(state)
  if (row.expires_at < Date.now()) return null
  return { destinationId: row.destination_id, username: row.username, redirectUri: row.redirect_uri }
}

module.exports = {
  init, SECRET_FIELDS, TYPES, listDestinations, getDestination, requireDestination, maskDestination,
  insertDestination, updateDestination, patchConfig, deleteDestination, createOAuthState, consumeOAuthState,
}
