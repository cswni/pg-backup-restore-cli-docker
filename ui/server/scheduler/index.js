const express = require('express')
const jobs = require('../jobs')
const { requireAdmin } = require('../auth')
const { httpError } = require('../validation')
const { handle } = require('../routes/util')
const store = require('./store')
const { normalizeSchedule } = require('./validate')
const { createEngine, overdueReason } = require('./engine')
const { cronError, nextRuns, nextRunAt, defaultTimezone } = require('./cron')

// Scheduled automatic backups.
//   GET    /api/schedules                 list (all roles)
//   GET    /api/schedules/preview?cron&tz next 5 run times (all roles)
//   GET    /api/schedules/:id
//   POST   /api/schedules                 create (admin)
//   PUT    /api/schedules/:id             update, partial bodies allowed (admin)
//   DELETE /api/schedules/:id             (admin)
//   POST   /api/schedules/:id/run         run now (any authenticated user)
//
// SCHEDULER_ENABLED=false disables the timer loop (e.g. on extra replicas);
// the API keeps working and "run now" still starts jobs.

const PREVIEW_COUNT = 5
let engine = createEngine()
let listening = false

/** Replace the engine (tests inject a clock and a fake backup starter). */
function configureEngine(deps) {
  engine.stop()
  engine = createEngine(deps)
  return engine
}

function getEngine() {
  return engine
}

function init() {
  store.migrateSchedules()
  if (!listening) {
    jobs.events.on('finished', (summary) => engine.onJobFinished(summary))
    listening = true
  }
  if (process.env.SCHEDULER_ENABLED !== 'false') engine.start()
}

/**
 * Schedules with derived monitoring state.
 * @param {number} [now]
 * @returns {Array<object>} schedule + { lastSuccessAt, overdue, overdueReason }
 */
function scheduleStates(now = engine.clock()) {
  const lastSuccess = store.lastSuccessBySchedule()
  return store.listSchedules().map((s) => {
    const lastSuccessAt = lastSuccess.get(s.id) ?? null
    const reason = overdueReason(s, lastSuccessAt, now)
    return { ...s, lastSuccessAt, overdue: !!reason, overdueReason: reason }
  })
}

/** next_run_at for a normalized schedule; keeps the current one when timing did not change. */
function computeNextRun(normalized, existing, now) {
  if (!normalized.enabled) return null
  const timingSame = existing && existing.enabled && existing.nextRunAt &&
    existing.cron === normalized.cron && existing.timezone === normalized.timezone
  return timingSame ? existing.nextRunAt : nextRunAt(normalized.cron, normalized.timezone, now)
}

function requireSchedule(id) {
  const s = store.getSchedule(id)
  if (!s) throw httpError(404, 'Schedule not found')
  return s
}

const router = express.Router()

router.get('/schedules', handle(async (req, res) => {
  res.json(scheduleStates())
}))

router.get('/schedules/preview', handle(async (req, res) => {
  const cron = typeof req.query.cron === 'string' ? req.query.cron.trim().replace(/\s+/g, ' ') : ''
  const tz = typeof req.query.tz === 'string' && req.query.tz ? req.query.tz : defaultTimezone()
  const err = cronError(cron, tz)
  if (err) throw httpError(400, err)
  const runs = nextRuns(cron, tz, engine.clock(), PREVIEW_COUNT).map((ms) => new Date(ms).toISOString())
  res.json({ cron, timezone: tz, runs })
}))

router.get('/schedules/:id', handle(async (req, res) => {
  res.json(requireSchedule(req.params.id))
}))

router.post('/schedules', requireAdmin, handle(async (req, res) => {
  const now = engine.clock()
  const normalized = normalizeSchedule(req.body)
  const created = store.insertSchedule({ ...normalized, nextRunAt: computeNextRun(normalized, null, now) }, req.user, now)
  res.status(201).json(created)
}))

router.put('/schedules/:id', requireAdmin, handle(async (req, res) => {
  const existing = requireSchedule(req.params.id)
  const now = engine.clock()
  const normalized = normalizeSchedule(req.body, existing)
  res.json(store.updateSchedule(existing.id, { ...normalized, nextRunAt: computeNextRun(normalized, existing, now) }, now))
}))

router.delete('/schedules/:id', requireAdmin, handle(async (req, res) => {
  if (!store.deleteSchedule(req.params.id)) throw httpError(404, 'Schedule not found')
  res.json({ ok: true })
}))

router.post('/schedules/:id/run', handle(async (req, res) => {
  res.json({ jobId: engine.runNow(req.params.id, req.user) })
}))

module.exports = { init, router, configureEngine, getEngine, scheduleStates }
