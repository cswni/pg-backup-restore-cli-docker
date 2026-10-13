const { execFile } = require('child_process')

// Docker access goes through the docker CLI (not the Engine API) so that
// DOCKER_HOST=ssh://… works for remote hosts exactly like the local socket.

const ENGINE_IMAGES = {
  postgres: ['postgres', 'postgis', 'bitnami/postgresql', 'supabase/postgres', 'timescale/timescaledb'],
}

/** Engine name for a container image, or null when unsupported. */
function detectEngine(image) {
  const img = (image || '').toLowerCase()
  for (const [engine, patterns] of Object.entries(ENGINE_IMAGES)) {
    if (patterns.some((p) => img.includes(p))) return engine
  }
  return null
}

/** Register extra image patterns for an engine (used by engine drivers). */
function registerEngineImages(engine, patterns) {
  ENGINE_IMAGES[engine] = [...(ENGINE_IMAGES[engine] || []), ...patterns]
}

/**
 * Run the docker CLI and resolve with stdout.
 * @param {string[]} args
 * @param {{ env?: object, timeout?: number, input?: string }} [opts]
 */
function docker(args, { env, timeout = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile('docker', args, { env: { ...process.env, ...env }, timeout, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) return reject(new Error((stderr || err.message).trim()))
        resolve(stdout)
      })
  })
}

/**
 * Running containers with a supported database engine.
 * @param {object} env  from servers.execEnv(server)
 */
async function listContainers(env) {
  const out = await docker(['ps', '--no-trunc', '--format', '{{json .}}'], { env })
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .map((c) => ({
      id: c.ID.slice(0, 12),
      idFull: c.ID,
      name: c.Names.split(',')[0],
      image: c.Image,
      engine: detectEngine(c.Image),
      status: c.Status,
      state: c.State,
      labels: parseLabels(c.Labels),
      created: c.CreatedAt,
    }))
    .filter((c) => c.engine)
}

function parseLabels(labels) {
  if (!labels) return {}
  return Object.fromEntries(labels.split(',').map((kv) => {
    const i = kv.indexOf('=')
    return i === -1 ? [kv, ''] : [kv.slice(0, i), kv.slice(i + 1)]
  }))
}

module.exports = { docker, listContainers, detectEngine, registerEngineImages }
