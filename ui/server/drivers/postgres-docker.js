const path = require('path')
const { SCRIPTS_DIR } = require('../config')
const { runCommand } = require('../jobs')
const { docker } = require('../docker')
const { execEnv } = require('../servers')

// PostgreSQL running in a Docker container. Reuses the CLI scripts so the
// UI and `docker run … export/restore` behave identically; the scripts honour
// DOCKER_HOST for remote daemons.

function script(name) {
  return path.join(SCRIPTS_DIR, name)
}

async function run(job, target, scriptName, args) {
  const env = await execEnv(target.server)
  return runCommand(job, 'bash', [script(scriptName), '-c', target.container, ...args], { env })
}

module.exports = {
  engine: 'postgres',
  kind: 'docker',
  label: 'PostgreSQL',
  fileExtension: '.sql',

  async listDatabases(target) {
    const env = await execEnv(target.server)
    const out = await docker(['exec', '-u', 'postgres', target.container, 'psql', '-lqt'], { env })
    return out
      .split('\n')
      .map((line) => line.split('|')[0].trim())
      .filter((name) => name && !['template0', 'template1'].includes(name))
  },

  dump(job, target, { database, outFile }) {
    return run(job, target, 'pg-export.sh', ['-d', database, '-o', outFile])
  },

  restore(job, target, { database, inFile, dropExisting }) {
    return run(job, target, 'pg-restore.sh', ['-d', database, '-f', inFile, ...(dropExisting ? ['-x'] : [])])
  },

  create(job, target, { database }) {
    return run(job, target, 'pg-create.sh', ['-d', database])
  },

  drop(job, target, { database }) {
    return run(job, target, 'pg-delete.sh', ['-d', database])
  },

  unblock(job, target, { database }) {
    return run(job, target, 'pg-unblock.sh', ['-d', database])
  },
}
