const { getDb, migrate } = require('../db')
const { encrypt, decrypt } = require('../secrets')

// Credentials an admin saved for a database container, per server and
// container key. Without a saved entry the drivers keep reading the
// container's own environment (MYSQL_ROOT_PASSWORD, MONGO_INITDB_ROOT_*...).
// The password is the only secret and is stored encrypted (secrets.js).

// Swarm task containers are named <service>.<slot>.<25-char task id>; keying by
// the service name keeps the credentials across redeploys.
const SWARM_TASK_RE = /^(.+)\.\d+\.[a-z0-9]{25}$/

const ENGINES = ['postgres', 'mysql', 'mongodb']

let migrated = false

function init() {
  migrate('containercreds-001-table', `
    CREATE TABLE container_credentials (
      server_id TEXT NOT NULL,
      key TEXT NOT NULL,
      engine TEXT NOT NULL,
      config TEXT NOT NULL DEFAULT '{}',
      secret TEXT,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (server_id, key)
    );
  `)
  migrated = true
}

function db() {
  if (!migrated) init()
  return getDb()
}

/** Storage key for a container: the Swarm service name for task containers, else the name. */
function credentialKey(containerName) {
  const name = String(containerName)
  const match = SWARM_TASK_RE.exec(name)
  return match ? match[1] : name
}

function readPassword(row) {
  if (!row.secret) return ''
  try {
    return decrypt(row.secret)
  } catch (err) {
    console.warn(`[pg-backup-ui] Cannot decrypt the saved password for container ${row.key} (was APP_SECRET changed?): ${err.message}`)
    return ''
  }
}

/** Row to a full record (WITH password; server-side use only). */
function rowToRecord(row) {
  const config = JSON.parse(row.config || '{}')
  return {
    serverId: row.server_id,
    key: row.key,
    engine: row.engine,
    username: config.username ?? null,
    osUser: config.osUser ?? null,
    host: config.host ?? null,
    authSource: config.authSource ?? null,
    password: readPassword(row),
    updatedAt: row.updated_at,
  }
}

function listCredentials(serverId) {
  return db().prepare('SELECT * FROM container_credentials WHERE server_id = ? ORDER BY key')
    .all(String(serverId)).map(rowToRecord)
}

/** @returns {object|null} */
function getCredentials(serverId, key) {
  const row = db().prepare('SELECT * FROM container_credentials WHERE server_id = ? AND key = ?').get(String(serverId), String(key))
  return row ? rowToRecord(row) : null
}

/**
 * Insert or replace the credentials of one container key.
 * @param {{ engine: string, username: string, password: string, osUser?: string|null, host?: string|null, authSource?: string|null }} record
 */
function saveCredentials(serverId, key, record) {
  const { engine, password, username, osUser = null, host = null, authSource = null } = record
  const config = JSON.stringify({ username, osUser, host, authSource })
  db().prepare(`INSERT INTO container_credentials (server_id, key, engine, config, secret, updated_at)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT (server_id, key) DO UPDATE SET
                  engine = excluded.engine, config = excluded.config, secret = excluded.secret, updated_at = excluded.updated_at`)
    .run(String(serverId), String(key), engine, config, password ? encrypt(password) : null, Date.now())
  return getCredentials(serverId, key)
}

/** @returns {boolean} whether something was deleted */
function deleteCredentials(serverId, key) {
  return db().prepare('DELETE FROM container_credentials WHERE server_id = ? AND key = ?').run(String(serverId), String(key)).changes > 0
}

/** Called when a server is deleted. */
function deleteForServer(serverId) {
  db().prepare('DELETE FROM container_credentials WHERE server_id = ?').run(String(serverId))
}

/**
 * Saved credentials for a container of a Docker server, or null.
 * With `engine`, an entry saved for another engine is ignored.
 */
function resolveFor(server, containerName, engine) {
  if (!server || server.kind !== 'docker' || !containerName) return null
  const record = getCredentials(server.id, credentialKey(containerName))
  if (!record || (engine && record.engine !== engine)) return null
  return record
}

/** Browser-safe view: the password becomes `passwordConfigured`. */
function toPublic(record) {
  const { password, serverId, ...rest } = record
  return { ...rest, passwordConfigured: !!password }
}

module.exports = {
  init, ENGINES, credentialKey, listCredentials, getCredentials, saveCredentials,
  deleteCredentials, deleteForServer, resolveFor, toPublic,
}
