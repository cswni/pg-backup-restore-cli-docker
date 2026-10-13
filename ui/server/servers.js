// Registry of places databases live.
//
// A server has a `kind`:
//   - 'docker': databases run in containers reached through the docker CLI.
//               `dockerHost` (e.g. ssh://user@host) selects a remote daemon;
//               null means the local socket.
//   - 'direct': (added by the connectivity module) a database host reached
//               over TCP, optionally through an SSH tunnel.
//
// Foundation version: only the built-in local Docker server. The
// connectivity module replaces the internals with a DB-backed registry while
// keeping these function signatures.

const LOCAL_SERVER = Object.freeze({
  id: 'local',
  name: 'Local Docker',
  kind: 'docker',
  dockerHost: null,
  builtin: true,
})

function listServers() {
  return [LOCAL_SERVER]
}

/** @returns {object|null} */
function getServer(id = 'local') {
  return listServers().find((s) => s.id === id) || null
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

/**
 * Environment variables for child processes acting on this server
 * (docker CLI and the bash scripts honour DOCKER_HOST).
 * May be async in richer implementations (e.g. to write SSH keys).
 */
async function execEnv(server) {
  return server.kind === 'docker' && server.dockerHost ? { DOCKER_HOST: server.dockerHost } : {}
}

module.exports = { listServers, getServer, requireServer, execEnv, LOCAL_SERVER }
