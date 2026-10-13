const webhooks = require('./webhooks')
const { createLogger } = require('./logger')

// Building notification events, rendering them for each webhook format and
// delivering them with a timeout and retries. Delivery never throws.

const log = createLogger('notifications')
const DEFAULT_DELIVERY = { timeoutMs: 10000, retries: 3, backoffMs: 1000 }
const DISCORD_MAX = 2000

let deliveryOptions = { ...DEFAULT_DELIVERY }

/** Override delivery timing (tests use tiny timeouts and no backoff). */
function setDeliveryOptions(opts) {
  deliveryOptions = { ...DEFAULT_DELIVERY, ...opts }
}

function jobLink(jobId) {
  const base = (process.env.PUBLIC_URL || '').replace(/\/+$/, '')
  return base ? `${base}/jobs/${jobId}` : null
}

function formatDuration(ms) {
  if (ms == null || ms < 0) return null
  const s = Math.round(ms / 1000)
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`
}

/**
 * Notification event for a finished job (from jobs.events 'finished').
 * @param {object} job  job summary
 * @param {number} [now]
 * @returns {{ type: string, title: string, lines: string[], data: object }}
 */
function jobEvent(job, now = Date.now()) {
  const ok = job.status === 'success'
  const m = job.meta || {}
  const target = [m.serverName || m.serverId, m.container, m.database].filter(Boolean).join(' / ')
  const lines = [
    `Job: ${job.type} (${job.id})`,
    target && `Target: ${target}`,
    m.scheduleName && `Schedule: ${m.scheduleName}`,
    job.username && `User: ${job.username}`,
    formatDuration(now - job.startedAt) && `Duration: ${formatDuration(now - job.startedAt)}`,
    m.file && `File: ${m.file}`,
    !ok && job.error && `Error: ${job.error}`,
    jobLink(job.id) && `Log: ${jobLink(job.id)}`,
  ].filter(Boolean)
  return {
    type: ok ? 'job.succeeded' : 'job.failed',
    title: `${ok ? '✅' : '❌'} ${job.type} ${ok ? 'succeeded' : 'failed'}${m.database ? `: ${m.database}` : ''}`,
    lines,
    data: {
      jobId: job.id, jobType: job.type, status: job.status, exitCode: job.exitCode, error: job.error || null,
      serverId: m.serverId, container: m.container, database: m.database, scheduleId: m.scheduleId || null,
      username: job.username, startedAt: job.startedAt, file: m.file || null,
    },
  }
}

/** Notification event for an overdue schedule. */
function overdueEvent(s, reason) {
  const since = s.lastSuccessAt ? new Date(s.lastSuccessAt).toISOString() : 'never'
  return {
    type: 'schedule.overdue',
    title: `⚠️ Backup schedule overdue: ${s.name}`,
    lines: [
      `Schedule "${s.name}" ${reason}.`,
      `Target: ${[s.serverId, s.container, s.database].filter(Boolean).join(' / ')}`,
      `Cron: ${s.cron} (${s.timezone})`,
      `Last successful backup: ${since}`,
    ],
    data: { scheduleId: s.id, schedule: s.name, reason, lastSuccessAt: s.lastSuccessAt || null, database: s.database },
  }
}

/** Test notification event. */
function testEvent() {
  return {
    type: 'test',
    title: '🔔 Test notification from PG Backup & Restore',
    lines: ['If you can read this, the webhook is configured correctly.'],
    data: {},
  }
}

/**
 * Render an event as the JSON body for a webhook format.
 * @param {string} format  generic | slack | discord | teams
 * @param {object} event
 * @param {number} [now]
 */
function renderPayload(format, event, now = Date.now()) {
  const text = event.lines.join('\n')
  if (format === 'slack') return { text: `*${event.title}*\n${text}` }
  if (format === 'discord') return { content: `**${event.title}**\n${text}`.slice(0, DISCORD_MAX) }
  if (format === 'teams') {
    return {
      type: 'message',
      attachments: [{
        contentType: 'application/vnd.microsoft.card.adaptive',
        content: {
          $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
          type: 'AdaptiveCard',
          version: '1.4',
          body: [
            { type: 'TextBlock', text: event.title, weight: 'Bolder', size: 'Medium', wrap: true },
            ...event.lines.map((l) => ({ type: 'TextBlock', text: l, wrap: true, spacing: 'Small' })),
          ],
        },
      }],
    }
  }
  return { event: event.type, title: event.title, text, timestamp: new Date(now).toISOString(), ...event.data }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const retryable = (status) => status === 429 || status >= 500

/**
 * POST JSON with a timeout, retrying network errors, 429 and 5xx.
 * @returns {Promise<{ ok: boolean, status: number|null, attempts: number, error: string|null }>}
 */
async function deliver(url, body, opts = deliveryOptions) {
  let last = { ok: false, status: null, attempts: 0, error: null }
  for (let attempt = 1; attempt <= opts.retries + 1; attempt += 1) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'user-agent': 'pg-backup-ui' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(opts.timeoutMs),
        redirect: 'error',
      })
      await res.arrayBuffer().catch(() => null)
      last = { ok: res.ok, status: res.status, attempts: attempt, error: res.ok ? null : `HTTP ${res.status}` }
      if (res.ok || !retryable(res.status)) return last
    } catch (err) {
      last = { ok: false, status: null, attempts: attempt, error: err.name === 'TimeoutError' ? 'Timed out' : err.message }
    }
    if (attempt <= opts.retries) await sleep(opts.backoffMs * 2 ** (attempt - 1))
  }
  return last
}

/**
 * Send to a single webhook. Never throws; never logs the URL.
 * @returns {Promise<object>} delivery result
 */
async function sendTo(webhook, event) {
  const { url, ...meta } = webhooks.webhookWithUrl(webhook)
  if (!url) return { ok: false, status: null, attempts: 0, error: 'No URL configured' }
  const result = await deliver(url, renderPayload(meta.format, event))
  const fields = { webhook: meta.name, webhookId: meta.id, event: event.type, attempts: result.attempts }
  if (result.ok) log.info('Notification sent', fields)
  else log.warn('Notification failed', { ...fields, error: result.error })
  return result
}

/**
 * Send an event to every enabled webhook subscribed to its type. Never throws.
 * @returns {Promise<object[]>} delivery results
 */
async function notify(event) {
  try {
    const targets = webhooks.readAll().filter((w) => w.enabled && w.events.includes(event.type))
    return await Promise.all(targets.map((w) => sendTo(w, event)))
  } catch (err) {
    log.error('Notification dispatch failed', { event: event.type, error: err.message })
    return []
  }
}

module.exports = {
  jobEvent, overdueEvent, testEvent, renderPayload, deliver, sendTo, notify, setDeliveryOptions,
}
