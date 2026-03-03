const Docker = require('dockerode')
const { execFile } = require('child_process')

const docker = new Docker({ socketPath: '/var/run/docker.sock' })

const POSTGRES_IMAGES = ['postgres', 'postgis', 'bitnami/postgresql', 'supabase/postgres', 'timescale/timescaledb']

function isPostgresContainer(container) {
  const image = (container.Image || '').toLowerCase()
  return POSTGRES_IMAGES.some((pg) => image.includes(pg))
}

/**
 * Returns all running containers that are running a postgres image.
 */
async function listContainers() {
  const containers = await docker.listContainers({ all: false })
  return containers
    .filter(isPostgresContainer)
    .map((c) => ({
      id: c.Id.slice(0, 12),
      idFull: c.Id,
      name: (c.Names[0] || '').replace(/^\//, ''),
      image: c.Image,
      status: c.Status,
      state: c.State,
      labels: c.Labels || {},
      created: c.Created,
    }))
}

/**
 * Returns database list for a given container (must be running postgres).
 * Runs: docker exec -u postgres <container> psql -lqt
 */
function listDatabases(containerName) {
  return new Promise((resolve, reject) => {
    execFile(
      'docker',
      ['exec', '-u', 'postgres', containerName, 'psql', '-lqt'],
      { timeout: 10000 },
      (err, stdout, stderr) => {
        if (err) {
          return reject(new Error(stderr || err.message))
        }
        // psql -lqt output: "name | owner | encoding | ..."
        const dbs = stdout
          .split('\n')
          .map((line) => line.split('|')[0].trim())
          .filter((name) => name && !['template0', 'template1', ''].includes(name))
        resolve(dbs)
      }
    )
  })
}

module.exports = { listContainers, listDatabases }

