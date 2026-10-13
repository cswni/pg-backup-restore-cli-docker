const childProcess = require('child_process')
const net = require('net')
const { CONFIG_FILE, syncSshConfig } = require('./ssh-config')
const { toolEnv } = require('./process')

// SSH tunnels for direct database connections.
//
// withConnection(server, fn) is the engine-agnostic entry point: drivers for
// any engine (PostgreSQL, MySQL, MongoDB…) get plain connection settings and
// never need to know whether a tunnel is involved.

const TUNNEL_TIMEOUT_MS = 20000
const POLL_INTERVAL_MS = 100
const CLOSE_TIMEOUT_MS = 3000

/** A free local TCP port (the tiny race with ssh binding it is caught by ExitOnForwardFailure). */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.unref()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
  })
}

function canConnect(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port })
    socket.once('connect', () => { socket.destroy(); resolve(true) })
    socket.once('error', () => resolve(false))
  })
}

/** Readable message from ssh's stderr. */
function sshError(stderr, fallback) {
  const lines = stderr.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('Warning: Permanently added'))
  return lines.length ? `SSH tunnel failed: ${lines.join(' ')}` : fallback
}

/** Resolve once 127.0.0.1:<port> accepts connections; reject if ssh exits or on timeout. */
function waitForPort(proc, port, timeoutMs, getStderr) {
  return new Promise((resolve, reject) => {
    let done = false
    const finish = (err) => {
      if (done) return
      done = true
      clearTimeout(timer)
      proc.removeListener('exit', onExit)
      err ? reject(err) : resolve()
    }
    const onExit = (code) => finish(new Error(sshError(getStderr(), `SSH tunnel exited with code ${code}`)))
    const timer = setTimeout(() => finish(new Error(
      sshError(getStderr(), `SSH tunnel did not open within ${Math.round(timeoutMs / 1000)}s`))), timeoutMs)
    proc.once('exit', onExit)
    proc.once('error', (err) => finish(new Error(`Cannot start ssh: ${err.message}`)))
    const poll = async () => {
      if (done) return
      // Only trust the port while our ssh is alive (another process could grab it)
      if (await canConnect(port) && proc.exitCode === null && proc.signalCode === null) return finish()
      setTimeout(poll, POLL_INTERVAL_MS)
    }
    poll()
  })
}

function stopProcess(proc) {
  return new Promise((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) return resolve()
    const timer = setTimeout(() => { proc.kill('SIGKILL'); resolve() }, CLOSE_TIMEOUT_MS)
    proc.once('exit', () => { clearTimeout(timer); resolve() })
    proc.kill('SIGTERM')
  })
}

/** `host:port` part of -L, with IPv6 hosts bracketed. */
function forwardTarget(host, port) {
  return host.includes(':') ? `[${host}]:${port}` : `${host}:${port}`
}

/**
 * Open `ssh -N -L 127.0.0.1:<free port>:<db host>:<db port>` through the
 * server's bastion.
 * @param {object} server  direct server with `tunnel`
 * @param {{ timeoutMs?: number, log?: (line: string) => void }} [opts]
 * @returns {Promise<{ host: string, port: number, close: () => Promise<void> }>}
 */
async function openTunnel(server, { timeoutMs = TUNNEL_TIMEOUT_MS, log } = {}) {
  syncSshConfig([server])
  const port = await freePort()
  const args = [
    '-F', CONFIG_FILE, '-N',
    '-o', 'ExitOnForwardFailure=yes',
    '-L', `127.0.0.1:${port}:${forwardTarget(server.host, server.port)}`,
    `pgui-${server.id}`,
  ]
  log?.(`[tunnel] Opening SSH tunnel via ${server.tunnel.user}@${server.tunnel.host}:${server.tunnel.port} → ${server.host}:${server.port}`)
  const proc = childProcess.spawn('ssh', args, { stdio: ['ignore', 'ignore', 'pipe'], env: toolEnv() })
  let stderr = ''
  proc.stderr.on('data', (d) => {
    stderr += d.toString()
    if (stderr.length > 8192) stderr = stderr.slice(-8192)
  })
  try {
    await waitForPort(proc, port, timeoutMs, () => stderr)
  } catch (err) {
    await stopProcess(proc)
    throw err
  }
  log?.(`[tunnel] Tunnel ready on 127.0.0.1:${port}`)
  return { host: '127.0.0.1', port, close: () => stopProcess(proc) }
}

/**
 * Run `fn` with connection settings for a direct server, through an SSH
 * tunnel when the server has one. The tunnel is always torn down afterwards,
 * also when `fn` throws.
 *
 * conn = { host, port, username, password, database, sslmode, tlsServerName? }
 *   host/port point at 127.0.0.1:<local port> when tunneled; tlsServerName
 *   is then the real database host (for TLS hostname verification).
 *
 * @template T
 * @param {object} server  a server with kind 'direct'
 * @param {(conn: object) => Promise<T>} fn
 * @param {{ log?: (line: string) => void, timeoutMs?: number }} [opts]
 * @returns {Promise<T>}
 */
async function withConnection(server, fn, opts = {}) {
  if (server.kind !== 'direct') throw new Error(`${server.name} is not a direct database server`)
  const conn = {
    host: server.host,
    port: server.port,
    username: server.username,
    password: server.password,
    database: server.database,
    sslmode: server.sslmode,
  }
  if (!server.tunnel) return fn(conn)
  const tunnel = await openTunnel(server, opts)
  try {
    return await fn({ ...conn, host: tunnel.host, port: tunnel.port, tlsServerName: server.host })
  } finally {
    await tunnel.close()
    opts.log?.('[tunnel] Tunnel closed')
  }
}

module.exports = { withConnection, openTunnel, freePort }
