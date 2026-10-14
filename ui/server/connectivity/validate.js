const { isValidDbName, httpError } = require('../validation')

// Input validation for the servers API. Values end up in a generated
// ssh_config and in libpq environment variables, so hosts and SSH users are
// restricted to characters that cannot break out of a config line.

const HOST_RE = /^(?!-)[A-Za-z0-9._:-]{1,253}$/
const SSH_USER_RE = /^[A-Za-z0-9._][A-Za-z0-9._-]{0,63}$/
// libpq user names can contain almost anything (e.g. user@server on Azure)
const DB_USER_RE = /^[^\s\x00-\x1f\x7f]{1,128}$/
const NAME_RE = /^[^\x00-\x1f\x7f]{1,64}$/
const SSL_MODES = ['disable', 'prefer', 'require', 'verify-full']
const DEFAULT_PORTS = { postgres: 5432, mysql: 3306, mariadb: 3306, mongodb: 27017 }
// PostgreSQL: database for admin statements; MySQL: unused; MongoDB: authSource
const DEFAULT_DATABASES = { postgres: 'postgres', mysql: 'mysql', mongodb: 'admin' }
const MAX_KEY_LENGTH = 16 * 1024

function str(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function requireMatch(value, re, label) {
  if (!re.test(value)) throw httpError(400, `Invalid ${label}`)
  return value
}

function host(value, label) {
  const h = str(value).replace(/^\[(.*)\]$/, '$1')
  if (!h) throw httpError(400, `${label} is required`)
  return requireMatch(h, HOST_RE, label)
}

function port(value, fallback, label) {
  if (value === undefined || value === null || value === '') return fallback
  const n = Number(value)
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw httpError(400, `Invalid ${label}`)
  return n
}

/** True for OpenSSH-format keys whose cipher is not "none". */
function isEncryptedOpenSshKey(pem) {
  const body = pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '')
  const raw = Buffer.from(body, 'base64')
  const magic = 'openssh-key-v1\0'
  if (raw.subarray(0, magic.length).toString('latin1') !== magic) return false
  const len = raw.readUInt32BE(magic.length)
  return raw.subarray(magic.length + 4, magic.length + 4 + len).toString('latin1') !== 'none'
}

/**
 * Normalize a pasted private key. Passphrase-protected keys are rejected:
 * ssh runs non-interactively (BatchMode), so use an unencrypted deploy key.
 * @returns {string|null} the key, or null when empty (= keep existing)
 */
function privateKey(value) {
  const key = typeof value === 'string' ? value.replace(/\r\n?/g, '\n').trim() : ''
  if (!key) return null
  if (key.length > MAX_KEY_LENGTH || !/^-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----\n[\s\S]+\n-----END [A-Z0-9 ]*PRIVATE KEY-----$/.test(key)) {
    throw httpError(400, 'Private key must be a PEM/OpenSSH private key (-----BEGIN … PRIVATE KEY-----)')
  }
  let encrypted = /ENCRYPTED/.test(key)
  try { encrypted = encrypted || isEncryptedOpenSshKey(key) } catch { /* not OpenSSH format */ }
  if (encrypted) throw httpError(400, 'Passphrase-protected keys are not supported. Use an unencrypted deploy key')
  return `${key}\n`
}

/** SSH endpoint (Docker host or tunnel bastion); key falls back to the existing one. */
function sshEndpoint(input, existing, label) {
  const src = input || {}
  const key = privateKey(src.privateKey) || existing?.privateKey || null
  if (!key) throw httpError(400, `${label} private key is required`)
  return {
    host: host(src.host, `${label} host`),
    port: port(src.port, 22, `${label} port`),
    user: requireMatch(str(src.user), SSH_USER_RE, `${label} user`),
    privateKey: key,
  }
}

function dockerRecord(body, existing) {
  return { name: serverName(body), kind: 'docker', ssh: sshEndpoint(body.ssh, existing?.ssh, 'SSH') }
}

function directRecord(body, existing, engines) {
  const engine = str(body.engine) || existing?.engine || 'postgres'
  if (!engines.includes(engine)) throw httpError(400, `Unsupported engine: ${engine}`)
  const database = str(body.database) || DEFAULT_DATABASES[engine] || 'postgres'
  if (!isValidDbName(database)) throw httpError(400, `Invalid database name: ${database}`)
  const sslmode = str(body.sslmode) || 'prefer'
  if (!SSL_MODES.includes(sslmode)) throw httpError(400, `Invalid SSL mode: ${sslmode}`)
  const password = typeof body.password === 'string' && body.password !== '' ? body.password : (existing?.password || '')
  const tunnelOn = body.tunnel && body.tunnel.enabled !== false
  return {
    name: serverName(body),
    kind: 'direct',
    engine,
    host: host(body.host, 'Host'),
    port: port(body.port, DEFAULT_PORTS[engine], 'Port'),
    username: requireMatch(str(body.username), DB_USER_RE, 'Username'),
    password,
    database,
    sslmode,
    tunnel: tunnelOn ? sshEndpoint(body.tunnel, existing?.tunnel, 'Tunnel') : null,
  }
}

function serverName(body) {
  return requireMatch(str(body.name), NAME_RE, 'name (1 to 64 characters)')
}

/**
 * Validate a create/update request into a storable record. On update, empty
 * secret fields keep the existing values.
 * @param {object} body     request body
 * @param {object|null} existing  current server (with secrets) on update
 * @param {string[]} engines  engines that have a 'direct' driver
 */
function validateServerInput(body, existing, engines) {
  const input = body && typeof body === 'object' ? body : {}
  const kind = existing?.kind || input.kind
  if (existing && input.kind && input.kind !== existing.kind) throw httpError(400, 'The kind of a server cannot be changed')
  if (kind === 'docker') return dockerRecord(input, existing)
  if (kind === 'direct') return directRecord(input, existing, engines)
  throw httpError(400, "Server type must be 'docker' or 'direct'")
}

/** Did the SSH endpoint move (so a stored host key no longer applies)? */
function endpointChanged(before, after) {
  const a = before?.kind === 'docker' ? before.ssh : before?.tunnel
  const b = after?.kind === 'docker' ? after.ssh : after?.tunnel
  if (!a || !b) return !!a !== !!b
  return a.host !== b.host || a.port !== b.port
}

module.exports = { validateServerInput, endpointChanged, privateKey, SSL_MODES, HOST_RE, DB_USER_RE }
