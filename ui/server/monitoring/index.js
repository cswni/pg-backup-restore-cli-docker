const crypto = require('crypto')
const express = require('express')
const { getDb } = require('../db')
const { listJobs } = require('../jobs')
const { requireAdmin } = require('../auth')
const { handle } = require('../routes/util')
const scheduler = require('../scheduler')
const { initJobLogs } = require('./joblogs')
const { initNotifier } = require('./notifier')
const { getHealth } = require('./health')
const { renderMetrics } = require('./metrics')
const webhooks = require('./webhooks')
const { sendTo, testEvent } = require('./notify')

// Logging & monitoring.
//   GET  /api/health                     public health check (no secrets)
//   GET  /api/metrics                    Prometheus; public with `Authorization: Bearer $METRICS_TOKEN`,
//                                        otherwise requires normal authentication
//   GET  /api/monitoring/summary         dashboard widgets (all roles)
//   GET  /api/monitoring/settings        webhook settings (admin)
//   POST /api/monitoring/settings/webhooks            create (admin)
//   PUT  /api/monitoring/settings/webhooks/:id        update (admin)
//   DELETE /api/monitoring/settings/webhooks/:id      (admin)
//   POST /api/monitoring/settings/webhooks/:id/test   send a test notification (admin)

const DAY_MS = 24 * 60 * 60 * 1000
const SUMMARY_LIMIT = 10
const PROM_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8'

function init() {
  initJobLogs()
  initNotifier()
}

/** Constant-time check of `Authorization: Bearer <METRICS_TOKEN>`. */
function hasMetricsToken(req) {
  const token = process.env.METRICS_TOKEN
  const [scheme, given] = String(req.headers.authorization || '').split(' ')
  if (!token || scheme !== 'Bearer' || !given) return false
  const digest = (s) => crypto.createHash('sha256').update(s).digest()
  return crypto.timingSafeEqual(digest(given), digest(token))
}

function sendMetrics(res) {
  res.setHeader('Content-Type', PROM_CONTENT_TYPE)
  res.send(renderMetrics())
}

function lastBackups() {
  return getDb().prepare(`
    SELECT json_extract(meta, '$.serverId') AS serverId, json_extract(meta, '$.serverName') AS serverName,
           json_extract(meta, '$.container') AS container, json_extract(meta, '$.database') AS database,
           MAX(finished_at) AS finishedAt, id AS jobId
    FROM jobs WHERE type = 'export' AND status = 'success'
    GROUP BY serverId, database ORDER BY finishedAt DESC
  `).all().map((r) => ({ ...r }))
}

function nextRuns(now) {
  return scheduler.scheduleStates(now)
    .filter((s) => s.enabled && s.nextRunAt)
    .sort((a, b) => a.nextRunAt - b.nextRunAt)
    .slice(0, SUMMARY_LIMIT)
    .map(({ id, name, database, container, nextRunAt, lastStatus, lastJobId, overdue, overdueReason }) =>
      ({ id, name, database, container, nextRunAt, lastStatus, lastJobId, overdue, overdueReason }))
}

const publicRouter = express.Router()

publicRouter.get('/health', handle(async (req, res) => {
  const health = await getHealth()
  res.status(health.status === 'error' ? 503 : 200).json(health)
}))

publicRouter.get('/metrics', (req, res, next) => (hasMetricsToken(req) ? sendMetrics(res) : next()))

const router = express.Router()

router.get('/metrics', handle(async (req, res) => sendMetrics(res)))

router.get('/monitoring/summary', handle(async (req, res) => {
  const now = Date.now()
  const recentFailures = listJobs({ status: 'error', limit: SUMMARY_LIMIT * 5 })
    .filter((j) => j.startedAt >= now - DAY_MS).slice(0, SUMMARY_LIMIT)
  res.json({ health: await getHealth(), recentFailures, lastBackups: lastBackups(), nextRuns: nextRuns(now) })
}))

router.get('/monitoring/settings', requireAdmin, handle(async (req, res) => {
  res.json({ webhooks: webhooks.listWebhooks(), formats: webhooks.FORMATS, events: webhooks.EVENTS })
}))

router.post('/monitoring/settings/webhooks', requireAdmin, handle(async (req, res) => {
  res.status(201).json(webhooks.createWebhook(req.body))
}))

router.put('/monitoring/settings/webhooks/:id', requireAdmin, handle(async (req, res) => {
  res.json(webhooks.updateWebhook(req.params.id, req.body))
}))

router.delete('/monitoring/settings/webhooks/:id', requireAdmin, handle(async (req, res) => {
  webhooks.deleteWebhook(req.params.id)
  res.json({ ok: true })
}))

router.post('/monitoring/settings/webhooks/:id/test', requireAdmin, handle(async (req, res) => {
  // Single attempt so the admin gets immediate feedback
  res.json(await sendTo(webhooks.findWebhook(req.params.id), testEvent(), { retries: 0 }))
}))

module.exports = { init, router, publicRouter }
