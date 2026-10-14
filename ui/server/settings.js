const { getDb, migrate } = require('./db')
const { encrypt, decrypt } = require('./secrets')

// Shared application settings (key → JSON value). Secret values are stored
// encrypted and must be read with getSecret(). Namespace keys by module,
// e.g. 'monitoring.webhooks'.

function init() {
  migrate('settings-001-table', `
    CREATE TABLE settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      secret INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    );
  `)
}

function getSetting(key, fallback = null) {
  const row = getDb().prepare('SELECT value, secret FROM settings WHERE key = ?').get(key)
  if (!row || row.secret) return fallback
  return JSON.parse(row.value)
}

function setSetting(key, value) {
  getDb().prepare(`
    INSERT INTO settings (key, value, secret, updated_at) VALUES (?, ?, 0, ?)
    ON CONFLICT (key) DO UPDATE SET value = excluded.value, secret = 0, updated_at = excluded.updated_at
  `).run(key, JSON.stringify(value), Date.now())
}

function getSecret(key, fallback = null) {
  const row = getDb().prepare('SELECT value, secret FROM settings WHERE key = ?').get(key)
  if (!row || !row.secret) return fallback
  return JSON.parse(decrypt(row.value))
}

function setSecret(key, value) {
  getDb().prepare(`
    INSERT INTO settings (key, value, secret, updated_at) VALUES (?, ?, 1, ?)
    ON CONFLICT (key) DO UPDATE SET value = excluded.value, secret = 1, updated_at = excluded.updated_at
  `).run(key, encrypt(JSON.stringify(value)), Date.now())
}

/** True when a secret is stored (lets the UI show "configured" without the value). */
function hasSecret(key) {
  return !!getDb().prepare('SELECT 1 FROM settings WHERE key = ? AND secret = 1').get(key)
}

function deleteSetting(key) {
  getDb().prepare('DELETE FROM settings WHERE key = ?').run(key)
}

module.exports = { init, getSetting, setSetting, getSecret, setSecret, hasSecret, deleteSetting }
