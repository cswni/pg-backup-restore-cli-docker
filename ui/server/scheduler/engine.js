const jobs = require('../jobs')
const { httpError } = require('../validation')
const { createLogger } = require('../monitoring/logger')
const store = require('./store')
const { nextRunAt, intervalMs } = require('./cron')

// Scheduler engine: a single timer loop that starts due schedules.
//
// Semantics
// - A schedule is due when enabled and next_run_at <= now.
// - Before starting a run, next_run_at is advanced to the first cron match
//   strictly after *now* (not after the missed slot). After downtime, a
//   schedule whose run(s) were missed therefore runs exactly ONCE (one
//   catch-up) and then continues on its normal cadence — missed runs are
//   never replayed one by one.
// - Overlap: if the schedule's previous job is still running, the due run is
//   skipped (logged as a warning) and next_run_at advances as usual.
// - Disabled schedules have next_run_at = NULL and never run.
// - The final job status is recorded from jobs.events 'finished'.

const DEFAULT_TICK_MS = 15000
const MISSED_GRACE_MS = 10 * 60 * 1000
const SCHEDULER_USER = Object.freeze({ id: null, username: 'scheduler', role: 'admin' })

function defaultStartBackup(body, user, extraMeta) {
  // Lazy require: routes/ops pulls in the pipeline and drivers.
  return require('../routes/ops').startBackupJob(body, user, extraMeta)
}

/** Body for routes/ops startBackupJob built from a schedule. */
function backupBody(s) {
  return {
    serverId: s.serverId,
    engine: s.engine,
    container: s.container || undefined,
    database: s.database,
    outputName: s.outputName || undefined,
    options: s.options,
  }
}

/**
 * Why a schedule is overdue, or null when it is healthy.
 * Overdue = enabled and either no successful run within 2× its interval
 * (measured from the later of the last success and the last edit), or its
 * next run is more than 10 minutes in the past (the engine missed it).
 * @param {object} s  schedule
 * @param {number|null} lastSuccessAt  ms
 * @param {number} now  ms
 * @returns {string|null}
 */
function overdueReason(s, lastSuccessAt, now) {
  if (!s.enabled) return null
  if (s.nextRunAt && now - s.nextRunAt > MISSED_GRACE_MS) return 'missed its scheduled run'
  const interval = intervalMs(s.cron, s.timezone, now)
  if (!interval) return null
  const since = Math.max(lastSuccessAt || 0, s.updatedAt || s.createdAt || 0)
  if (now - since > 2 * interval) return lastSuccessAt ? 'no successful backup within 2× its interval' : 'has never completed a successful backup'
  return null
}

/**
 * Create a scheduler engine.
 * @param {object} [deps]
 * @param {() => number} [deps.clock]        current time in ms (injectable for tests)
 * @param {Function} [deps.startBackup]      (body, user, extraMeta) => jobId
 * @param {(id: string) => object|null} [deps.getJob]
 * @param {object} [deps.logger]
 */
function createEngine(deps = {}) {
  const clock = deps.clock || Date.now
  const startBackup = deps.startBackup || defaultStartBackup
  const getJob = deps.getJob || jobs.getJob
  const log = deps.logger || createLogger('scheduler')
  let timer = null

  function isRunning(s) {
    return !!s.lastJobId && getJob(s.lastJobId)?.status === 'running'
  }

  function launch(s, user, now) {
    const jobId = startBackup(backupBody(s), user, { scheduleId: s.id, scheduleName: s.name })
    store.recordRun(s.id, { at: now, jobId, status: 'running' })
    return jobId
  }

  function runDue(s, now) {
    store.setNextRun(s.id, nextRunAt(s.cron, s.timezone, now))
    if (isRunning(s)) {
      log.warn('Skipping run: previous run still in progress', { scheduleId: s.id, schedule: s.name, jobId: s.lastJobId })
      return
    }
    try {
      const jobId = launch(s, SCHEDULER_USER, now)
      log.info('Started scheduled backup', { scheduleId: s.id, schedule: s.name, jobId, due: new Date(s.nextRunAt).toISOString() })
    } catch (err) {
      store.recordRun(s.id, { at: now, jobId: null, status: 'error' })
      log.error('Cannot start scheduled backup', { scheduleId: s.id, schedule: s.name, error: err.message })
    }
  }

  /** Start every due schedule once. Never throws. */
  function tick() {
    const now = clock()
    try {
      store.dueSchedules(now).forEach((s) => runDue(s, now))
    } catch (err) {
      log.error('Scheduler tick failed', { error: err.message })
    }
  }

  /**
   * Start a schedule immediately (does not change next_run_at).
   * @returns {string} job id
   */
  function runNow(id, user) {
    const s = store.getSchedule(id)
    if (!s) throw httpError(404, 'Schedule not found')
    if (isRunning(s)) throw httpError(409, 'A run of this schedule is already in progress')
    const jobId = launch(s, user, clock())
    log.info('Manual run of schedule', { scheduleId: s.id, schedule: s.name, jobId, user: user?.username })
    return jobId
  }

  /** jobs.events 'finished' listener. Never throws. */
  function onJobFinished(summary) {
    const scheduleId = summary?.meta?.scheduleId
    if (!scheduleId) return
    try {
      store.recordJobFinished(scheduleId, summary.id, summary.status)
    } catch (err) {
      log.error('Cannot record schedule run result', { scheduleId, error: err.message })
    }
  }

  /** Recompute next_run_at for enabled schedules that have none (e.g. after an upgrade). */
  function fillMissingNextRuns() {
    const now = clock()
    store.listSchedules().filter((s) => s.enabled && !s.nextRunAt)
      .forEach((s) => store.setNextRun(s.id, nextRunAt(s.cron, s.timezone, now)))
  }

  function start(tickMs = DEFAULT_TICK_MS) {
    if (timer) return
    fillMissingNextRuns()
    timer = setInterval(tick, tickMs)
    timer.unref()
    setImmediate(() => timer && tick()) // first tick right away: catch-up after a restart
    log.info('Scheduler started', { tickMs })
  }

  function stop() {
    if (timer) clearInterval(timer)
    timer = null
  }

  return { tick, runNow, onJobFinished, start, stop, isRunning, clock }
}

module.exports = { createEngine, overdueReason, backupBody, SCHEDULER_USER, MISSED_GRACE_MS }
