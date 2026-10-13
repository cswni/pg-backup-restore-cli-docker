const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const { DATA_DIR } = require('../config')

// Managed OpenSSH configuration for remote Docker hosts and SSH tunnels.
//
// Everything lives in DATA_DIR/ssh:
//   config        one `Host pgui-<id>` block per server that uses SSH
//   <id>.key      the server's private key (0600), decrypted from the DB
//   known_hosts   trust-on-first-use host keys (HostKeyAlias pgui-<id>)
//   bin/ssh       wrapper: `exec <real ssh> -F DATA_DIR/ssh/config "$@"`
//
// The docker CLI runs plain `ssh` (looked up on PATH) for DOCKER_HOST=ssh://…
// and has no option to pass ssh flags, and OpenSSH reads ~/.ssh/config from
// the passwd home directory (not $HOME). So instead of editing the user's
// ~/.ssh/config, child processes get bin/ first on PATH: the wrapper pins
// `-F` to the managed config, which keeps it scoped to our own processes.

const SSH_DIR = path.join(DATA_DIR, 'ssh')
const CONFIG_FILE = path.join(SSH_DIR, 'config')
const KNOWN_HOSTS = path.join(SSH_DIR, 'known_hosts')
const BIN_DIR = path.join(SSH_DIR, 'bin')
const KEY_RE = /^[0-9a-f]{6,32}\.key$/

/** Atomic write (readers never see a half-written file). */
function writeAtomic(file, content, mode = 0o600) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`
  fs.writeFileSync(tmp, content, { mode })
  fs.renameSync(tmp, file)
}

function keyFile(id) {
  return path.join(SSH_DIR, `${id}.key`)
}

/** The SSH endpoint a server uses (Docker host or tunnel bastion), or null. */
function sshEndpoint(server) {
  if (server.builtin) return null
  if (server.kind === 'docker') return server.ssh || null
  return server.tunnel || null
}

/** Double-quoted ssh_config value (paths may contain spaces). */
function q(value) {
  return `"${String(value).replace(/\\/g, '/')}"`
}

/** ssh_config block for one server. Host/user are validated before storage. */
function renderHost(id, endpoint) {
  const alias = `pgui-${id}`
  return [
    `Host ${alias}`,
    `  HostName ${endpoint.host}`,
    `  Port ${endpoint.port}`,
    `  User ${endpoint.user}`,
    `  IdentityFile ${q(keyFile(id))}`,
    '  IdentitiesOnly yes',
    `  HostKeyAlias ${alias}`,
    '  StrictHostKeyChecking accept-new',
    `  UserKnownHostsFile ${q(KNOWN_HOSTS)}`,
    '  GlobalKnownHostsFile /dev/null',
    '  HashKnownHosts no',
    '  CheckHostIP no',
    '  BatchMode yes',
    '  ConnectTimeout 15',
    '  ServerAliveInterval 30',
    '  ServerAliveCountMax 3',
    '',
  ].join('\n')
}

/** Full managed config for a list of servers. */
function renderConfig(servers) {
  const header = '# Managed by pg-backup-ui — regenerated automatically, do not edit.\n\n'
  return header + servers
    .map((s) => ({ id: s.id, endpoint: sshEndpoint(s) }))
    .filter((e) => e.endpoint)
    .map((e) => renderHost(e.id, e.endpoint))
    .join('\n')
}

/** Shell single-quoting for the wrapper script. */
function shq(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

/** Absolute path of the system ssh binary (skipping our own wrapper). */
function findRealSsh() {
  const dirs = (process.env.PATH || '').split(path.delimiter).filter((d) => d && path.resolve(d) !== path.resolve(BIN_DIR))
  for (const dir of dirs) {
    const candidate = path.join(dir, 'ssh')
    if (fs.existsSync(candidate)) return candidate
  }
  return '/usr/bin/ssh'
}

function writeWrapper() {
  fs.mkdirSync(BIN_DIR, { recursive: true })
  const script = `#!/bin/sh\n# Managed by pg-backup-ui: use the managed ssh config\nexec ${shq(findRealSsh())} -F ${shq(CONFIG_FILE)} "$@"\n`
  writeAtomic(path.join(BIN_DIR, 'ssh'), script, 0o755)
}

/**
 * Write keys, config and wrapper for every server that uses SSH, and remove
 * key files of servers that no longer exist. Safe to call often.
 * @param {object[]} [extra]  servers to include besides the registry (they
 *   replace registry entries with the same id, e.g. the one about to be used)
 */
function syncSshConfig(extra = []) {
  const ids = new Set(extra.map((s) => s.id))
  const all = [...require('../servers').listServers().filter((s) => !ids.has(s.id)), ...extra]
  fs.mkdirSync(SSH_DIR, { recursive: true, mode: 0o700 })
  const wanted = new Set()
  for (const s of all) {
    const endpoint = sshEndpoint(s)
    if (!endpoint || !endpoint.privateKey) continue
    wanted.add(`${s.id}.key`)
    writeAtomic(keyFile(s.id), endpoint.privateKey, 0o600)
  }
  for (const f of fs.readdirSync(SSH_DIR)) {
    if (KEY_RE.test(f) && !wanted.has(f)) fs.rmSync(path.join(SSH_DIR, f), { force: true })
  }
  writeAtomic(CONFIG_FILE, renderConfig(all), 0o600)
  writeWrapper()
}

/**
 * Environment that makes the docker CLI (and the bash scripts) reach a
 * remote Docker host over SSH.
 */
async function dockerEnv(server) {
  syncSshConfig([server])
  return {
    DOCKER_HOST: `ssh://pgui-${server.id}`,
    PATH: [BIN_DIR, process.env.PATH].filter(Boolean).join(path.delimiter),
  }
}

/** SHA256 fingerprint in OpenSSH format for a base64 public key blob. */
function fingerprint(base64Key) {
  const digest = crypto.createHash('sha256').update(Buffer.from(base64Key, 'base64')).digest('base64')
  return `SHA256:${digest.replace(/=+$/, '')}`
}

function readKnownHosts() {
  return fs.existsSync(KNOWN_HOSTS) ? fs.readFileSync(KNOWN_HOSTS, 'utf8').split('\n') : []
}

function lineMatches(line, id) {
  const hosts = line.trim().split(/\s+/)[0] || ''
  return hosts.split(',').some((h) => h === `pgui-${id}` || h.startsWith(`[pgui-${id}]:`))
}

/**
 * Host keys trusted for a server (recorded on first connection).
 * @returns {{ type: string, fingerprint: string }[]}
 */
function hostKeys(id) {
  return readKnownHosts()
    .filter((line) => line && !line.startsWith('#') && lineMatches(line, id))
    .map((line) => {
      const [, type, key] = line.trim().split(/\s+/)
      return { type, fingerprint: fingerprint(key || '') }
    })
}

/** Forget the stored host key(s) so the next connection trusts the new one. */
function forgetHostKey(id) {
  const lines = readKnownHosts()
  const kept = lines.filter((line) => !lineMatches(line, id))
  if (kept.length !== lines.length) writeAtomic(KNOWN_HOSTS, kept.join('\n'), 0o600)
  return lines.length - kept.length
}

module.exports = {
  SSH_DIR, CONFIG_FILE, KNOWN_HOSTS, BIN_DIR,
  syncSshConfig, dockerEnv, renderConfig, hostKeys, forgetHostKey, fingerprint, keyFile, sshEndpoint,
}
