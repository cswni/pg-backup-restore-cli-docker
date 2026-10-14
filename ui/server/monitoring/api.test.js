const { setupTestEnv, startTestServer } = require('../test-helpers')
setupTestEnv({ SCHEDULER_ENABLED: 'false', LOG_LEVEL: 'error' })

const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const http = require('http')
const express = require('express')
const jobs = require('../jobs')
const settings = require('../settings')
const scheduleStore = require('../scheduler/store')
const monitoring = require('./index')
const { setDockerProbe } = require('./health')
const { setDeliveryOptions } = require('./notify')
const { checkOverdue, INCIDENTS_KEY } = require('./notifier')

const HOUR = 3600000
const received = []
let hook
let hookUrl
let srv

async function waitFor(pred, ms = 2000) {
  const end = Date.now() + ms
  while (!pred()) {
    if (Date.now() > end) throw new Error('timed out waiting')
    await new Promise((r) => setTimeout(r, 10))
  }
}

function runJob(type, meta, fail) {
  return new Promise((resolve) => {
    const id = jobs.startJob(type, meta, async () => { if (fail) throw new Error(fail) })
    const on = (s) => {
      if (s.id !== id) return
      jobs.events.removeListener('finished', on)
      setImmediate(() => resolve(id))
    }
    jobs.events.on('finished', on)
  })
}

async function startRoleApp(role) {
  const app = express()
  app.use(express.json())
  app.use((req, res, next) => { req.user = { id: 2, username: 'bob', role }; next() })
  app.use('/api', monitoring.router)
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
  const base = `http://127.0.0.1:${server.address().port}`
  return {
    request: async (method, p, body) => {
      const res = await fetch(base + p, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined })
      return { status: res.status }
    },
    close: () => new Promise((r) => server.close(r)),
  }
}

before(async () => {
  setDeliveryOptions({ timeoutMs: 500, retries: 2, backoffMs: 0 })
  hook = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      received.push({ path: req.url, body: JSON.parse(body || 'null') })
      res.writeHead(req.url.startsWith('/fail') ? 500 : 200).end('ok')
    })
  })
  await new Promise((r) => hook.listen(0, '127.0.0.1', r))
  hookUrl = `http://127.0.0.1:${hook.address().port}`
  srv = await startTestServer()
})

after(async () => {
  await srv.close()
  await new Promise((r) => hook.close(r))
})

test('GET /api/health is public and reports version, uptime, db and docker', async () => {
  setDockerProbe(async () => '27.1.0\n')
  const ok = await srv.request('GET', '/api/health', { noAuth: true })
  assert.equal(ok.status, 200)
  assert.equal(ok.json.status, 'ok')
  assert.equal(ok.json.version, require('../../package.json').version)
  assert.equal(typeof ok.json.uptimeSeconds, 'number')
  assert.deepEqual(ok.json.checks, { database: { ok: true }, docker: { reachable: true, serverVersion: '27.1.0' } })

  setDockerProbe(async () => { throw new Error('Cannot connect to the Docker daemon at unix:///secret.sock') })
  const degraded = await srv.request('GET', '/api/health', { noAuth: true })
  assert.equal(degraded.status, 200)
  assert.equal(degraded.json.status, 'degraded')
  assert.deepEqual(degraded.json.checks.docker, { reachable: false })
  assert.doesNotMatch(degraded.text, /secret\.sock/)
})

test('docker probe results are cached', async () => {
  let calls = 0
  setDockerProbe(async () => { calls += 1; return '1' })
  await srv.request('GET', '/api/health', { noAuth: true })
  await srv.request('GET', '/api/health', { noAuth: true })
  assert.equal(calls, 1)
})

test('metrics require auth without METRICS_TOKEN and expose Prometheus text', async () => {
  delete process.env.METRICS_TOKEN
  await runJob('export', { serverId: 'local', database: 'app' })
  await runJob('export', { serverId: 'local', database: 'app' }, 'boom')
  fs.writeFileSync(path.join(process.env.BACKUPS_DIR, 'app_01-01-2026_00_00_00.sql'), '12345')

  assert.equal((await srv.request('GET', '/api/metrics', { noAuth: true })).status, 401)
  const res = await srv.request('GET', '/api/metrics')
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-type'), /^text\/plain;.*version=0\.0\.4/)
  assert.match(res.text, /# TYPE pgbackup_jobs_total counter/)
  assert.match(res.text, /pgbackup_jobs_total\{type="export",status="success"\} 1/)
  assert.match(res.text, /pgbackup_jobs_total\{type="export",status="error"\} 1/)
  assert.match(res.text, /pgbackup_job_duration_seconds_bucket\{type="export",le="\+Inf"\} 2/)
  assert.match(res.text, /pgbackup_job_duration_seconds_count\{type="export"\} 2/)
  assert.match(res.text, /pgbackup_last_successful_backup_timestamp_seconds\{server="local",database="app"\} \d{10}/)
  assert.match(res.text, /pgbackup_backup_files 1/)
  assert.match(res.text, /pgbackup_backup_bytes 5/)
  assert.match(res.text, /pgbackup_up 1/)
})

test('metrics accept a valid bearer METRICS_TOKEN without other auth', async () => {
  process.env.METRICS_TOKEN = 'scrape-secret'
  try {
    const ok = await srv.request('GET', '/api/metrics', { noAuth: true, headers: { authorization: 'Bearer scrape-secret' } })
    assert.equal(ok.status, 200)
    assert.match(ok.text, /pgbackup_up 1/)
    const wrong = await srv.request('GET', '/api/metrics', { noAuth: true, headers: { authorization: 'Bearer nope' } })
    assert.equal(wrong.status, 401)
    const basic = await srv.request('GET', '/api/metrics')
    assert.equal(basic.status, 200)
  } finally {
    delete process.env.METRICS_TOKEN
  }
})

test('schedule metrics include overdue state', async () => {
  const s = scheduleStore.insertSchedule({
    name: 'metrics "quoted"', enabled: true, cron: '0 * * * *', timezone: 'UTC', serverId: 'local', engine: 'postgres',
    container: 'pg', database: 'm', options: {}, nextRunAt: Date.now() - 2 * HOUR,
  }, { username: 'admin' }, Date.now() - 5 * HOUR)
  const res = await srv.request('GET', '/api/metrics')
  assert.ok(res.text.includes(`pgbackup_schedule_overdue{schedule_id="${s.id}",schedule="metrics \\"quoted\\""} 1`))
  assert.ok(res.text.includes(`pgbackup_schedule_last_success_timestamp_seconds{schedule_id="${s.id}",schedule="metrics \\"quoted\\""} 0`))
  scheduleStore.deleteSchedule(s.id)
})

test('webhook CRUD never returns the URL', async () => {
  const created = await srv.request('POST', '/api/monitoring/settings/webhooks', {
    body: { name: 'ops', url: `${hookUrl}/ops?token=abc`, format: 'slack', events: ['job.failed'] },
  })
  assert.equal(created.status, 201, created.text)
  assert.equal(created.json.configured, true)
  assert.equal(created.json.enabled, true)
  assert.equal(created.json.url, undefined)

  const got = await srv.request('GET', '/api/monitoring/settings')
  assert.doesNotMatch(got.text, /token=abc/)
  assert.deepEqual(got.json.formats, ['generic', 'slack', 'discord', 'teams'])
  assert.equal(got.json.webhooks.length, 1)

  const updated = await srv.request('PUT', `/api/monitoring/settings/webhooks/${created.json.id}`, { body: { name: 'ops2', url: '' } })
  assert.equal(updated.json.name, 'ops2')
  assert.equal(updated.json.format, 'slack')
  assert.equal(settings.getSecret(`monitoring.webhook.${created.json.id}.url`), `${hookUrl}/ops?token=abc`)

  const del = await srv.request('DELETE', `/api/monitoring/settings/webhooks/${created.json.id}`)
  assert.equal(del.status, 200)
  assert.equal(settings.hasSecret(`monitoring.webhook.${created.json.id}.url`), false)
  assert.equal((await srv.request('DELETE', `/api/monitoring/settings/webhooks/${created.json.id}`)).status, 404)
})

test('webhook validation', async () => {
  const cases = [
    [{ name: 'x', url: 'ftp://example.com' }, /http or https/],
    [{ name: 'x', url: 'not a url' }, /valid URL/],
    [{ name: 'x' }, /Webhook URL is required/],
    [{ name: '', url: 'https://example.com' }, /Name is required/],
    [{ name: 'x', url: 'https://example.com', format: 'pager' }, /Format must be/],
    [{ name: 'x', url: 'https://example.com', events: ['job.exploded'] }, /Events must be/],
    [{ name: 'x', url: 'https://example.com', enabled: 'yes' }, /Enabled must be true or false/],
  ]
  for (const [body, re] of cases) {
    const res = await srv.request('POST', '/api/monitoring/settings/webhooks', { body })
    assert.equal(res.status, 400, JSON.stringify(body))
    assert.match(res.json.error, re)
  }
})

test('test endpoint sends a test notification to the webhook', async () => {
  const { json: w } = await srv.request('POST', '/api/monitoring/settings/webhooks', {
    body: { name: 'teams', url: `${hookUrl}/teams`, format: 'teams', events: [] },
  })
  received.length = 0
  const res = await srv.request('POST', `/api/monitoring/settings/webhooks/${w.id}/test`)
  assert.equal(res.status, 200)
  assert.equal(res.json.ok, true)
  assert.equal(received[0].path, '/teams')
  assert.match(received[0].body.attachments[0].content.body[0].text, /Test notification/)
  await srv.request('DELETE', `/api/monitoring/settings/webhooks/${w.id}`)
})

test('test endpoint makes a single attempt and reports the failure', async () => {
  const { json: w } = await srv.request('POST', '/api/monitoring/settings/webhooks', {
    body: { name: 'broken', url: `${hookUrl}/fail`, format: 'generic', events: [] },
  })
  received.length = 0
  const res = await srv.request('POST', `/api/monitoring/settings/webhooks/${w.id}/test`)
  assert.deepEqual(res.json, { ok: false, status: 500, attempts: 1, error: 'HTTP 500' })
  assert.equal(received.length, 1)
  assert.equal((await srv.request('POST', '/api/monitoring/settings/webhooks/missing/test')).status, 404)
  await srv.request('DELETE', `/api/monitoring/settings/webhooks/${w.id}`)
})

test('finished jobs trigger notifications without affecting the job', async () => {
  const { json: w } = await srv.request('POST', '/api/monitoring/settings/webhooks', {
    body: { name: 'generic', url: `${hookUrl}/generic`, format: 'generic', events: ['job.failed', 'job.succeeded'] },
  })
  received.length = 0
  const id = await runJob('export', { serverId: 'local', database: 'notify_db' }, 'dump exploded')
  await waitFor(() => received.some((r) => r.body.jobId === id))
  const body = received.find((r) => r.body.jobId === id).body
  assert.equal(body.event, 'job.failed')
  assert.equal(body.error, 'dump exploded')
  assert.equal(jobs.getJob(id).status, 'error')
  await srv.request('DELETE', `/api/monitoring/settings/webhooks/${w.id}`)
})

test('overdue schedules notify once per incident and clear when healthy', async () => {
  const { json: w } = await srv.request('POST', '/api/monitoring/settings/webhooks', {
    body: { name: 'overdue', url: `${hookUrl}/overdue`, format: 'discord', events: ['schedule.overdue'] },
  })
  const now = Date.now()
  const s = scheduleStore.insertSchedule({
    name: 'hourly', enabled: true, cron: '0 * * * *', timezone: 'UTC', serverId: 'local', engine: 'postgres',
    container: 'pg', database: 'h', options: {}, nextRunAt: now + 30 * 60000,
  }, { username: 'admin' }, now - 3 * HOUR)
  received.length = 0

  assert.deepEqual(await checkOverdue(now), [s.id])
  assert.equal(received.length, 1)
  assert.match(received[0].body.content, /Backup schedule overdue: hourly/)
  assert.deepEqual(await checkOverdue(now + 60000), [])
  assert.equal(received.length, 1)
  assert.ok(settings.getSetting(INCIDENTS_KEY)[s.id])

  scheduleStore.updateSchedule(s.id, { ...s, nextRunAt: s.nextRunAt }, now) // edit resets the overdue clock
  assert.deepEqual(await checkOverdue(now + 120000), [])
  assert.equal(settings.getSetting(INCIDENTS_KEY)[s.id], undefined)
  scheduleStore.deleteSchedule(s.id)
  await srv.request('DELETE', `/api/monitoring/settings/webhooks/${w.id}`)
})

test('summary returns health, recent failures, last backups and next runs', async () => {
  const s = scheduleStore.insertSchedule({
    name: 'soon', enabled: true, cron: '0 * * * *', timezone: 'UTC', serverId: 'local', engine: 'postgres',
    container: 'pg', database: 'soon_db', options: {}, nextRunAt: Date.now() + 60000,
  }, { username: 'admin' }, Date.now())
  const res = await srv.request('GET', '/api/monitoring/summary')
  assert.equal(res.status, 200)
  assert.ok(['ok', 'degraded'].includes(res.json.health.status))
  assert.ok(res.json.recentFailures.every((j) => j.status === 'error'))
  assert.ok(res.json.recentFailures.length >= 1)
  const app = res.json.lastBackups.find((b) => b.database === 'app')
  assert.ok(app.finishedAt && app.jobId)
  assert.equal(res.json.nextRuns[0].id, s.id)
  scheduleStore.deleteSchedule(s.id)
})

test('non-admins can read the summary and metrics but not webhook settings', async () => {
  const app = await startRoleApp('user')
  try {
    assert.equal((await app.request('GET', '/api/monitoring/summary')).status, 200)
    assert.equal((await app.request('GET', '/api/metrics')).status, 200)
    assert.equal((await app.request('GET', '/api/monitoring/settings')).status, 403)
    assert.equal((await app.request('POST', '/api/monitoring/settings/webhooks', { name: 'x', url: 'https://e.com' })).status, 403)
    assert.equal((await app.request('POST', '/api/monitoring/settings/webhooks/x/test')).status, 403)
  } finally {
    await app.close()
  }
})
