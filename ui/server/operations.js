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

/**
 * Run an operation and return jobId immediately.
 * @param {string} operation - one of export|create|delete|unblock|restore
 * @param {object} params    - { container, database, file? }
 */
function runOperation(operation, params) {
  const script = SCRIPT_MAP[operation]
  if (!script) throw new Error(`Unknown operation: ${operation}`)

  const { container, database, file } = params
  const args = ['-c', container, '-d', database]
  if (file) args.push('-f', file)

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

module.exports = { runOperation, getJob, listJobs }

