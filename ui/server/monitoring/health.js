const { getDb } = require('../db')
const { docker } = require('../docker')
const { version } = require('../../package.json')

// Health check (public, no secrets): app version, uptime, database and
// local Docker CLI reachability. The Docker probe is cached because it
// shells out.

const DOCKER_TIMEOUT_MS = 3000
const DOCKER_CACHE_MS = 30000

let dockerProbe = () => docker(['version', '--format', '{{.Server.Version}}'], { timeout: DOCKER_TIMEOUT_MS })
let cache = { at: 0, value: null }

/** Replace the Docker probe (tests). Clears the cache. */
function setDockerProbe(fn) {
  dockerProbe = fn
  cache = { at: 0, value: null }
}

async function checkDocker(now = Date.now()) {
  if (cache.value && now - cache.at < DOCKER_CACHE_MS) return cache.value
  let value
  try {
    const out = await dockerProbe()
    value = { reachable: true, serverVersion: String(out || '').trim() || null }
  } catch {
    value = { reachable: false }
  }
  cache = { at: now, value }
  return value
}

function checkDb() {
  try {
    getDb().prepare('SELECT 1').get()
    return { ok: true }
  } catch {
    return { ok: false }
  }
}

/**
 * Current health. `status` is 'ok', 'degraded' (Docker unreachable) or
 * 'error' (database unusable).
 * @returns {Promise<object>}
 */
async function getHealth() {
  const db = checkDb()
  const dockerState = await checkDocker()
  const status = !db.ok ? 'error' : dockerState.reachable ? 'ok' : 'degraded'
  return {
    status,
    version,
    uptimeSeconds: Math.round(process.uptime()),
    time: new Date().toISOString(),
    checks: { database: db, docker: dockerState },
  }
}

module.exports = { getHealth, setDockerProbe }
