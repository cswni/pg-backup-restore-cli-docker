const dockerCli = require('../docker')
const { execEnv } = require('../servers')
const { getDriver } = require('../drivers')

// "Test connection" for any server kind: Docker hosts run `docker version`
// and `docker ps` through the server's environment, direct servers delegate
// to their driver's testConnection() (which opens the SSH tunnel if any).

const DOCKER_TIMEOUT_MS = 30000

async function testDocker(server) {
  const env = await execEnv(server)
  const version = (await dockerCli.docker(['version', '--format', '{{.Server.Version}}'], { env, timeout: DOCKER_TIMEOUT_MS })).trim()
  const running = (await dockerCli.docker(['ps', '-q'], { env, timeout: DOCKER_TIMEOUT_MS })).split('\n').filter(Boolean).length
  return { version: `Docker ${version}`, details: `${running} running container(s)` }
}

async function testDirect(server) {
  const driver = getDriver(server.engine, 'direct')
  if (typeof driver.testConnection !== 'function') throw new Error(`${driver.label} does not support connection tests`)
  return driver.testConnection({ server })
}

/**
 * Check that a server is reachable.
 * @param {object} server  from servers.requireServer
 * @returns {Promise<{ ok: boolean, latencyMs: number, version?: string, details?: string, error?: string }>}
 */
async function testServer(server) {
  const started = Date.now()
  try {
    const result = server.kind === 'docker' ? await testDocker(server) : await testDirect(server)
    return { ok: true, latencyMs: Date.now() - started, ...result }
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - started, error: err.message }
  }
}

module.exports = { testServer }
