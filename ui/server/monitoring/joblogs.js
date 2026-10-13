const fs = require('fs')
const path = require('path')
const { DATA_DIR } = require('../config')
const jobs = require('../jobs')
const { createLogger } = require('./logger')

// Persistent job logs: every log line is appended to DATA_DIR/logs/<jobId>.log
// as JSON lines while the job runs, so logs outlive the in-memory retention
// window and server restarts. Files older than JOB_LOG_RETENTION_DAYS
// (default 30) are deleted by a daily sweep.

const log = createLogger('joblogs')
const LOGS_DIR = path.join(DATA_DIR, 'logs')
const MAX_PERSISTED_LINES = 50000
const DAY_MS = 24 * 60 * 60 * 1000
const DEFAULT_RETENTION_DAYS = 30
const JOB_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const lineCounts = new Map()
let sweepTimer = null
let writeErrorLogged = false

function retentionDays() {
  const n = Number(process.env.JOB_LOG_RETENTION_DAYS)
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_RETENTION_DAYS
}

/** Path of a job's log file, or null for ids that are not job UUIDs (path traversal guard). */
function logFile(jobId) {
  return JOB_ID_RE.test(String(jobId)) ? path.join(LOGS_DIR, `${jobId}.log`) : null
}

/** True while the job is below the persisted line cap. The final 'done' line is always kept. */
function underCap(jobId, line) {
  if (line.type === 'done') {
    lineCounts.delete(jobId)
    return true
  }
  const count = (lineCounts.get(jobId) || 0) + 1
  lineCounts.set(jobId, count)
  return count <= MAX_PERSISTED_LINES
}

/**
 * Append one line to the job's log file. Never throws (must not break jobs).
 * @param {string} jobId
 * @param {{type: string, text: string, ts: number}} line
 */
function appendLine(jobId, line) {
  const file = logFile(jobId)
  if (!file || !underCap(jobId, line)) return
  try {
    fs.mkdirSync(LOGS_DIR, { recursive: true })
    fs.appendFileSync(file, JSON.stringify(line) + '\n')
  } catch (err) {
    if (!writeErrorLogged) log.error('Cannot persist job log', { jobId, error: err.message })
    writeErrorLogged = true
  }
}

/**
 * Stored log lines of a job ([] when there is no file).
 * @param {string} jobId
 * @returns {Array<{type: string, text: string, ts: number}>}
 */
function readJobLog(jobId) {
  const file = logFile(jobId)
  if (!file || !fs.existsSync(file)) return []
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap((l) => {
    try {
      return [JSON.parse(l)]
    } catch {
      return []
    }
  })
}

/**
 * Delete log files last modified more than JOB_LOG_RETENTION_DAYS ago.
 * @param {number} [now]
 * @returns {number} number of files deleted
 */
function sweepOldLogs(now = Date.now()) {
  if (!fs.existsSync(LOGS_DIR)) return 0
  const cutoff = now - retentionDays() * DAY_MS
  let removed = 0
  for (const name of fs.readdirSync(LOGS_DIR)) {
    if (!name.endsWith('.log')) continue
    const file = path.join(LOGS_DIR, name)
    try {
      if (fs.statSync(file).mtimeMs < cutoff) {
        fs.rmSync(file, { force: true })
        removed += 1
      }
    } catch (err) {
      log.warn('Cannot delete old job log', { file: name, error: err.message })
    }
  }
  if (removed) log.info('Deleted old job logs', { removed, retentionDays: retentionDays() })
  return removed
}

function safeSweep() {
  try {
    sweepOldLogs()
  } catch (err) {
    log.warn('Job log sweep failed', { error: err.message })
  }
}

/** Wire persistence into the job runner and schedule the daily sweep. */
function initJobLogs() {
  if (sweepTimer) return
  jobs.events.on('line', appendLine)
  jobs.setLogReader(readJobLog)
  safeSweep()
  sweepTimer = setInterval(safeSweep, DAY_MS)
  sweepTimer.unref()
}

module.exports = { initJobLogs, appendLine, readJobLog, sweepOldLogs, LOGS_DIR }
