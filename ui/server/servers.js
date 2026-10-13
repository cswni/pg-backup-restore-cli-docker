const crypto = require('crypto')
const { getDb, migrate } = require('./db')
const { encrypt, decrypt } = require('./secrets')

// Registry of places databases live.
//
// A server has a `kind`:
//   - 'docker': databases run in containers reached through the docker CLI.
//               `dockerHost` (ssh://pgui-<id>) selects a remote daemon over
//               SSH; null means the local socket.
//   - 'direct': a database host reached over TCP (host/port/user/password),
//               optionally through an SSH tunnel. The client tools run in
//               this image.
//
// The built-in `local` server always exists and is not stored. Other servers
// live in the `servers` table; secrets (private keys, passwords) are kept in
// one AES-GCM encrypted JSON column and never leave the server (see toPublic).

const LOCAL_SERVER = Object.freeze({
  id: 'local',
  name: 'Local Docker',
  kind: 'docker',
  dockerHost: null,
  builtin: true,
})

/** SSH host alias used in the managed ssh config (and as HostKeyAlias). */
function sshAlias(id) {
  return `pgui-${id}`
}

let migrated = false

/** Create the servers table (idempotent; also called lazily). */
function init() {
  migrate('servers-001-table', `
    CREATE TABLE servers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      config TEXT NOT NULL DEFAULT '{}',
      secrets TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `)
  migrated = true
}

function db() {
  if (!migrated) init()
  return getDb()
}

/** Decrypted secrets; {} when unreadable (e.g. APP_SECRET changed) so listing still works. */
function readSecrets(row) {
  if (!row.secrets) return {}
  try {
    return JSON.parse(decrypt(row.secrets))
  } catch (err) {
    console.warn(`[pg-backup-ui] Cannot decrypt secrets of server ${row.id} (was APP_SECRET changed?): ${err.message}`)
    return {}
  }
}

/** Row → full server object (WITH secrets; server-side use only). */
function rowToServer(row) {
  const config = JSON.parse(row.config || '{}')
  const secrets = readSecrets(row)
  const base = { id: row.id, name: row.name, kind: row.kind, builtin: false, createdAt: row.created_at, updatedAt: row.updated_at }
  if (row.kind === 'docker') {
    return {
      ...base,
      dockerHost: `ssh://${sshAlias(row.id)}`,
      ssh: { ...config.ssh, privateKey: secrets.sshPrivateKey || null },
    }
  }
  return {
    ...base,
    engine: config.engine || 'postgres',
    host: config.host,
    port: config.port,
    username: config.username,
    password: secrets.password || '',
    database: config.database,
    sslmode: config.sslmode || 'prefer',
    tunnel: config.tunnel ? { ...config.tunnel, privateKey: secrets.tunnelPrivateKey || null } : null,
  }
}

/** All servers, the built-in local one first. */
function listServers() {
  const rows = db().prepare('SELECT * FROM servers ORDER BY name COLLATE NOCASE').all()
  return [LOCAL_SERVER, ...rows.map(rowToServer)]
}

/** @returns {object|null} */
function getServer(id = 'local') {
  if (id === 'local') return LOCAL_SERVER
  const row = db().prepare('SELECT * FROM servers WHERE id = ?').get(String(id))
  return row ? rowToServer(row) : null
}

/** Throws a 404-style error when the server does not exist. */
function requireServer(id = 'local') {
  const server = getServer(id)
  if (!server) {
    const err = new Error(`Unknown server: ${id}`)
    err.status = 404
    throw err
  }
  return server
}

/** Split a normalized record into the stored config and secrets. */
function splitRecord(record) {
  if (record.kind === 'docker') {
    const { privateKey, ...ssh } = record.ssh
    return { config: { ssh }, secrets: { sshPrivateKey: privateKey } }
  }
  const { name, kind, password, tunnel, ...config } = record
  if (!tunnel) return { config: { ...config, tunnel: null }, secrets: { password } }
  const { privateKey, ...tunnelConfig } = tunnel
  return { config: { ...config, tunnel: tunnelConfig }, secrets: { password, tunnelPrivateKey: privateKey } }
}

/**
 * Insert a server from a validated record (see connectivity/validate.js).
 * @returns {object} the stored server (with secrets)
 */
function createServer(record) {
  const id = crypto.randomBytes(6).toString('hex')
  const { config, secrets } = splitRecord(record)
  const now = Date.now()
  db().prepare(`INSERT INTO servers (id, name, kind, config, secrets, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(id, record.name, record.kind, JSON.stringify(config), encrypt(JSON.stringify(secrets)), now, now)
  return getServer(id)
}

/** Replace a server's settings with a validated, merged record. */
function updateServer(id, record) {
  const { config, secrets } = splitRecord(record)
  db().prepare('UPDATE servers SET name = ?, kind = ?, config = ?, secrets = ?, updated_at = ? WHERE id = ?')
    .run(record.name, record.kind, JSON.stringify(config), encrypt(JSON.stringify(secrets)), Date.now(), id)
  return getServer(id)
}

function deleteServer(id) {
  db().prepare('DELETE FROM servers WHERE id = ?').run(id)
}

/**
 * Browser-safe view of a server: secrets are replaced by `*Configured` flags.
 * @param {object} server
 * @param {{ hostKeys?: object[] }} [extra]
 */
function toPublic(server, extra = {}) {
  if (server.builtin) return { ...server, ...extra }
  const base = { id: server.id, name: server.name, kind: server.kind, builtin: false, ...extra }
  if (server.kind === 'docker') {
    const { privateKey, ...ssh } = server.ssh || {}
    return { ...base, ssh: { ...ssh, keyConfigured: !!privateKey } }
  }
  const { privateKey, ...tunnel } = server.tunnel || {}
  return {
    ...base,
    engine: server.engine,
    host: server.host,
    port: server.port,
    username: server.username,
    database: server.database,
    sslmode: server.sslmode,
    passwordConfigured: !!server.password,
    tunnel: server.tunnel ? { ...tunnel, keyConfigured: !!privateKey } : null,
  }
}

/**
 * Environment variables for child processes acting on this server
 * (docker CLI and the bash scripts honour DOCKER_HOST). For remote Docker
 * hosts this materializes the managed SSH config and key, and puts the ssh
 * wrapper that uses it first on PATH.
 */
async function execEnv(server) {
  if (server.kind !== 'docker' || !server.dockerHost) return {}
  if (server.builtin) return { DOCKER_HOST: server.dockerHost }
  const ssh = require('./connectivity/ssh-config')
  return ssh.dockerEnv(server)
}

module.exports = {
  init, listServers, getServer, requireServer, execEnv, LOCAL_SERVER,
  createServer, updateServer, deleteServer, toPublic, sshAlias,
}
