const jobs = require('../jobs')
const settings = require('../settings')
const scheduler = require('../scheduler')
const { notify, jobEvent, overdueEvent } = require('./notify')
const { createLogger } = require('./logger')

// Wires notifications to job completion and checks schedules for overdue
// incidents once a minute. Each overdue incident is notified once; it is
// cleared (and can fire again later) when the schedule is healthy again.
// Open incidents are persisted so a restart does not re-notify.

const log = createLogger('monitoring')
const INCIDENTS_KEY = 'monitoring.overdueIncidents'
const OVERDUE_CHECK_MS = 60 * 1000

let started = false

/** jobs.events 'finished' listener: fire-and-forget, never throws. */
function onJobFinished(summary) {
  try {
    notify(jobEvent(summary)).catch(() => {})
  } catch (err) {
    log.error('Cannot build job notification', { jobId: summary?.id, error: err.message })
  }
}

/**
 * Detect newly overdue schedules, notify them once, and clear resolved incidents.
 * @param {number} [now]
 * @returns {Promise<string[]>} ids of schedules that opened a new incident
 */
async function checkOverdue(now = Date.now()) {
  const states = scheduler.scheduleStates(now)
  const open = settings.getSetting(INCIDENTS_KEY, {}) || {}
  const overdue = states.filter((s) => s.overdue)
  const fresh = overdue.filter((s) => !open[s.id])
  const next = Object.fromEntries(overdue.map((s) => [s.id, open[s.id] || now]))
  settings.setSetting(INCIDENTS_KEY, next)
  for (const s of fresh) {
    log.warn('Schedule overdue', { scheduleId: s.id, schedule: s.name, reason: s.overdueReason })
    await notify(overdueEvent(s, s.overdueReason))
  }
  return fresh.map((s) => s.id)
}

async function safeCheckOverdue() {
  try {
    await checkOverdue()
  } catch (err) {
    log.error('Overdue check failed', { error: err.message })
  }
}

/** Register the job listener and the overdue timer (idempotent). */
function initNotifier() {
  if (started) return
  started = true
  jobs.events.on('finished', onJobFinished)
  if (process.env.SCHEDULER_ENABLED === 'false') return
  const timer = setInterval(safeCheckOverdue, OVERDUE_CHECK_MS)
  timer.unref()
}

module.exports = { initNotifier, checkOverdue, onJobFinished, INCIDENTS_KEY }
