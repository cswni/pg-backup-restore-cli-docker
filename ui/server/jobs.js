const { spawn } = require('child_process')
const { randomUUID } = require('crypto')
const EventEmitter = require('events')
const { getDb, migrate } = require('./db')

// Live jobs keep their log lines in memory for SSE streaming; every job is
// also recorded in the `jobs` table so history survives restarts.
const live = new Map()
const LIVE_RETENTION_MS = 10 * 60 * 1000
const MAX_LOG_LINES = 5000

// Job lifecycle events (monitoring/notifications hook in here):
//   'line'     (jobId, line)  every log line, including the final 'done' line
//   'finished' (summary)      once per job, after the DB row is updated
// Listeners must not throw.
const events = new EventEmitter()

// Optional reader for log lines of jobs no longer in memory (persisted logs).
let logReader = null

/**
 * Register a function returning the stored log lines of a finished job.
 * @param {(id: string) => Array<{type: string, text: string, ts: number}>} fn
 */
function setLogReader(fn) {
  logReader = fn
}

function storedLines(id) {
  if (!logReader) return []
  try {
    return logReader(id) || []
  } catch {
    return []
  }
}

function init() {
  migrate('jobs-001-table', `
    CREATE TABLE jobs (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      status TEXT NOT NULL,
      meta TEXT NOT NULL DEFAULT '{}',
      username TEXT,
      started_at INTEGER NOT NULL,
      finished_at INTEGER,
      exit_code INTEGER,
      error TEXT
    );
    CREATE INDEX jobs_started_at ON jobs (started_at DESC);
  `)
  // Jobs that were running when the process died can never finish.
  getDb().prepare("UPDATE jobs SET status = 'error', error = 'Interrupted by server restart' WHERE status = 'running'").run()
}

/**
 * Start a job and run `work(job)` in the background.
 * `work` is an async function; throwing marks the job as failed.
 * @param {string} type  e.g. 'backup', 'restore', 'create'
 * @param {object} meta  JSON-serialisable details shown in the UI (server, database, file…)
 * @param {(job) => Promise<void>} work
 * @param {{ username?: string }} [opts]
 * @returns {string} job id
 */
function startJob(type, meta, work, opts = {}) {
  const id = randomUUID()
  const job = {
    id,
    type,
    meta,
    username: opts.username || null,
    status: 'running',
    startedAt: Date.now(),
    exitCode: null,
    error: null,
    lines: [],
    emitter: new EventEmitter(),
    log(text, stream = 'stdout') {
      String(text).split('\n').filter(Boolean).forEach((l) => {
        const line = { type: stream, text: l, ts: Date.now() }
        if (job.lines.length < MAX_LOG_LINES) job.lines.push(line)
        job.emitter.emit('line', line)
        events.emit('line', id, line)
      })
    },
  }
  live.set(id, job)
  getDb().prepare(
    'INSERT INTO jobs (id, type, status, meta, username, started_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(id, type, 'running', JSON.stringify(meta), job.username, job.startedAt)

  Promise.resolve()
    .then(() => work(job))
    .then(() => finish(job, 0, null))
    .catch((err) => {
      job.log(err.message, 'stderr')
      finish(job, typeof err.exitCode === 'number' ? err.exitCode : 1, err.message)
    })

  return id
}

function finish(job, exitCode, error) {
  job.status = exitCode === 0 ? 'success' : 'error'
  job.exitCode = exitCode
  job.error = error
  const line = { type: 'done', text: `Process exited with code ${exitCode}`, ts: Date.now() }
  job.lines.push(line)
  job.emitter.emit('line', line)
  events.emit('line', job.id, line)
  job.emitter.emit('done', exitCode)
  getDb().prepare(
    'UPDATE jobs SET status = ?, exit_code = ?, error = ?, finished_at = ?, meta = ? WHERE id = ?'
  ).run(job.status, exitCode, error, Date.now(), JSON.stringify(job.meta), job.id)
  events.emit('finished', publicJob(job))
  setTimeout(() => live.delete(job.id), LIVE_RETENTION_MS).unref()
}

/**
 * Run a command as part of a job, streaming its output into the job log.
 * Resolves on exit code 0, rejects otherwise (err.exitCode is set).
 */
function runCommand(job, command, args, { env, stdin } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, { env: { ...process.env, ...env } })
    proc.stdout.on('data', (d) => job.log(d.toString(), 'stdout'))
    proc.stderr.on('data', (d) => job.log(d.toString(), 'stderr'))
    if (stdin) stdin.pipe(proc.stdin)
    proc.on('error', reject)
    proc.on('close', (code) => {
      if (code === 0) return resolve()
      const err = new Error(`${command} exited with code ${code}`)
      err.exitCode = code
      reject(err)
    })
  })
}

function publicJob(job) {
  return {
    id: job.id,
    type: job.type,
    // Kept for older clients that read `operation`, `container`, `database`
    operation: job.type,
    container: job.meta.container,
    database: job.meta.database,
    meta: job.meta,
    username: job.username,
    status: job.status,
    startedAt: job.startedAt,
    exitCode: job.exitCode,
    error: job.error,
  }
}

function rowToJob(row) {
  const meta = JSON.parse(row.meta || '{}')
  return {
    id: row.id,
    type: row.type,
    operation: row.type,
    container: meta.container,
    database: meta.database,
    meta,
    username: row.username,
    status: row.status,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    exitCode: row.exit_code,
    error: row.error,
  }
}

/** Live job (with log lines) or null. */
function getLiveJob(id) {
  return live.get(id) || null
}

/** Job summary from memory or history. */
function getJob(id) {
  const j = live.get(id)
  if (j) return { ...publicJob(j), lines: j.lines }
  const row = getDb().prepare('SELECT * FROM jobs WHERE id = ?').get(id)
  return row ? { ...rowToJob(row), lines: storedLines(id) } : null
}

function listJobs({ limit = 50, offset = 0, type, status } = {}) {
  const where = []
  const params = []
  if (type) { where.push('type = ?'); params.push(type) }
  if (status) { where.push('status = ?'); params.push(status) }
  const sql = `SELECT * FROM jobs ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
               ORDER BY started_at DESC LIMIT ? OFFSET ?`
  return getDb().prepare(sql).all(...params, limit, offset).map(rowToJob)
}

module.exports = { init, startJob, runCommand, getJob, getLiveJob, listJobs, setLogReader, events }
