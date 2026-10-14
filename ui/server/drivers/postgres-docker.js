const path = require('path')
const { SCRIPTS_DIR } = require('../config')
const { runCommand } = require('../jobs')
const { capture } = require('../connectivity/process')
const { execEnv } = require('../servers')
const { postgresAccess, postgresExecOptions, postgresScriptEnv } = require('../containercreds/access')

// PostgreSQL running in a Docker container. Reuses the CLI scripts so the
// UI and `docker run … export/restore` behave identically; the scripts honour
// DOCKER_HOST for remote daemons and PG_EXEC_USER / PGUSER / PGPASSWORD /
// PGHOST for saved container credentials (scripts/pg-exec.sh).

const LIST_TIMEOUT_MS = 15000

function script(name) {
  return path.join(SCRIPTS_DIR, name)
}

/** Environment for the pg-*.sh scripts (DOCKER_HOST plus saved credentials). */
async function scriptEnv(target) {
  return { ...(await execEnv(target.server)), ...postgresScriptEnv(postgresAccess(target)) }
}

async function run(job, target, scriptName, args) {
  return runCommand(job, 'bash', [script(scriptName), '-c', target.container, ...args], { env: await scriptEnv(target) })
}

module.exports = {
  engine: 'postgres',
  kind: 'docker',
  label: 'PostgreSQL',
  fileExtension: '.sql',

  async listDatabases(target) {
    const access = postgresAccess(target)
    const env = { ...process.env, ...(await execEnv(target.server)), ...access.env }
    const args = ['exec', ...postgresExecOptions(access), target.container, 'psql', '-lqt']
    const out = await capture('docker', args, { env, timeout: LIST_TIMEOUT_MS })
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

  _internals: { scriptEnv },
}
