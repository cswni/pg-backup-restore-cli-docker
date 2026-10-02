const { spawn } = require('child_process')
const { v4: uuidv4 } = require('uuid')
const EventEmitter = require('events')

// In-memory job store: Map<jobId, { emitter, lines, status, startedAt, command }>
const jobs = new Map()

const SCRIPT_MAP = {
  export: '/usr/local/bin/pg-export.sh',
  create: '/usr/local/bin/pg-create.sh',
  delete: '/usr/local/bin/pg-delete.sh',
  unblock: '/usr/local/bin/pg-unblock.sh',
  restore: '/usr/local/bin/pg-restore.sh',
}

// Same rule as the shell scripts: names are always double-quoted in SQL,
// so only a safe character set is accepted.
const DB_NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_$-]{0,62}$/

function isValidDbName(name) {
  return typeof name === 'string' && DB_NAME_RE.test(name)
}

/**
 * Run an operation and return jobId immediately.
 * @param {string} operation - one of export|create|delete|unblock|restore
 * @param {object} params    - { container, database, file?, dropExisting?, outputName? }
 */
function runOperation(operation, params) {
  const script = SCRIPT_MAP[operation]
  if (!script) throw new Error(`Unknown operation: ${operation}`)

  const { container, database, file, dropExisting, outputName } = params
  const args = ['-c', container, '-d', database]
  if (operation === 'restore' && file) args.push('-f', file)
  if (operation === 'restore' && dropExisting) args.push('-x')
  if (operation === 'export' && outputName) args.push('-n', outputName)

  const jobId = uuidv4()
  const emitter = new EventEmitter()
  const lines = []
  const job = {
    emitter,
    lines,
    status: 'running',
    startedAt: Date.now(),
    operation,
    container,
    database,
    exitCode: null,
  }
  jobs.set(jobId, job)

  const proc = spawn('bash', [script, ...args], {
    env: { ...process.env, PATH: process.env.PATH || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' },
  })

  const emit = (type, text) => {
    const line = { type, text, ts: Date.now() }
    lines.push(line)
    emitter.emit('line', line)
  }

  proc.stdout.on('data', (d) => {
    d.toString().split('\n').filter(Boolean).forEach((l) => emit('stdout', l))
  })
  proc.stderr.on('data', (d) => {
    d.toString().split('\n').filter(Boolean).forEach((l) => emit('stderr', l))
  })

  proc.on('close', (code) => {
    job.status = code === 0 ? 'success' : 'error'
    job.exitCode = code
    emit('done', `Process exited with code ${code}`)
    emitter.emit('done', code)
    // Clean up job after 10 minutes
    setTimeout(() => jobs.delete(jobId), 10 * 60 * 1000)
  })

  return jobId
}

function getJob(jobId) {
  return jobs.get(jobId) || null
}

function listJobs() {
  return Array.from(jobs.entries()).map(([id, j]) => ({
    id,
    operation: j.operation,
    container: j.container,
    database: j.database,
    status: j.status,
    startedAt: j.startedAt,
    exitCode: j.exitCode,
  }))
}

module.exports = { runOperation, getJob, listJobs, isValidDbName }

