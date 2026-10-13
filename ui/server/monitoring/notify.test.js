const { setupTestEnv } = require('../test-helpers')
setupTestEnv({ SCHEDULER_ENABLED: 'false', LOG_LEVEL: 'error', PUBLIC_URL: 'https://backups.example.com/' })

const { test, before, after, beforeEach } = require('node:test')
const assert = require('node:assert/strict')
const http = require('http')
const settings = require('../settings')
const webhooks = require('./webhooks')
const { jobEvent, overdueEvent, renderPayload, deliver, notify, setDeliveryOptions } = require('./notify')

// Local webhook receiver: behaviour per path, records every request.
const received = []
let plan = {}
let server
let base

before(async () => {
  settings.init()
  setDeliveryOptions({ timeoutMs: 300, retries: 2, backoffMs: 1 })
  server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      received.push({ path: req.url, body: body ? JSON.parse(body) : null, headers: req.headers })
      const statuses = plan[req.url] || [200]
      const status = statuses.length > 1 ? statuses.shift() : statuses[0]
      if (status === 'hang') return // never answer → client timeout
      res.writeHead(status).end('ok')
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${server.address().port}`
})

after(() => new Promise((r) => { server.closeAllConnections(); server.close(r) }))

beforeEach(() => {
  received.length = 0
  plan = {}
  for (const w of webhooks.readAll()) webhooks.deleteWebhook(w.id)
})

const failedJob = {
  id: 'job-1', type: 'export', status: 'error', exitCode: 1, error: 'pg_dump: connection refused', username: 'scheduler',
  startedAt: Date.now() - 65000, meta: { serverId: 'local', serverName: 'Local Docker', container: 'pg', database: 'app', scheduleId: 's1', scheduleName: 'Nightly' },
}

test('jobEvent describes failures and successes', () => {
  const ev = jobEvent(failedJob, failedJob.startedAt + 65000)
  assert.equal(ev.type, 'job.failed')
  assert.match(ev.title, /export failed: app/)
  assert.ok(ev.lines.includes('Target: Local Docker / pg / app'))
  assert.ok(ev.lines.includes('Schedule: Nightly'))
  assert.ok(ev.lines.includes('Duration: 1m 5s'))
  assert.ok(ev.lines.includes('Error: pg_dump: connection refused'))
  assert.ok(ev.lines.includes('Log: https://backups.example.com/jobs/job-1'))
  const ok = jobEvent({ ...failedJob, status: 'success', error: null })
  assert.equal(ok.type, 'job.succeeded')
  assert.ok(!ok.lines.some((l) => l.startsWith('Error')))
})

test('renders generic, Slack, Discord and Teams payloads', () => {
  const ev = jobEvent(failedJob)
  const generic = renderPayload('generic', ev, 0)
  assert.equal(generic.event, 'job.failed')
  assert.equal(generic.jobId, 'job-1')
  assert.equal(generic.database, 'app')
  assert.equal(generic.timestamp, '1970-01-01T00:00:00.000Z')
  assert.match(renderPayload('slack', ev).text, /^\*❌ export failed: app\*\n/)
  assert.match(renderPayload('discord', ev).content, /^\*\*❌ export failed/)
  assert.equal(renderPayload('discord', { ...ev, lines: ['x'.repeat(5000)] }).content.length, 2000)
  const teams = renderPayload('teams', ev)
  assert.equal(teams.type, 'message')
  const card = teams.attachments[0]
  assert.equal(card.contentType, 'application/vnd.microsoft.card.adaptive')
  assert.equal(card.content.type, 'AdaptiveCard')
  assert.equal(card.content.body[0].text, ev.title)
})

test('overdueEvent explains the incident', () => {
  const ev = overdueEvent({ id: 's1', name: 'Nightly', serverId: 'local', container: 'pg', database: 'app', cron: '0 2 * * *', timezone: 'UTC', lastSuccessAt: null }, 'has never completed a successful backup')
  assert.equal(ev.type, 'schedule.overdue')
  assert.ok(ev.lines.includes('Last successful backup: never'))
})

test('deliver posts JSON and succeeds on 2xx', async () => {
  const r = await deliver(`${base}/ok`, { hello: 'world' })
  assert.deepEqual(r, { ok: true, status: 200, attempts: 1, error: null })
  assert.deepEqual(received[0].body, { hello: 'world' })
  assert.equal(received[0].headers['content-type'], 'application/json')
})

test('deliver retries 5xx and 429, then succeeds', async () => {
  plan['/flaky'] = [500, 429, 200]
  const r = await deliver(`${base}/flaky`, {})
  assert.equal(r.ok, true)
  assert.equal(r.attempts, 3)
})

test('deliver gives up after the retries and does not retry 4xx', async () => {
  plan['/down'] = [503]
  const down = await deliver(`${base}/down`, {})
  assert.deepEqual(down, { ok: false, status: 503, attempts: 3, error: 'HTTP 503' })
  received.length = 0
  plan['/bad'] = [400]
  const bad = await deliver(`${base}/bad`, {})
  assert.equal(bad.attempts, 1)
  assert.equal(received.length, 1)
})

test('deliver times out on a hanging endpoint and reports network errors', async () => {
  plan['/hang'] = ['hang']
  const r = await deliver(`${base}/hang`, {}, { timeoutMs: 50, retries: 0, backoffMs: 0 })
  assert.deepEqual(r, { ok: false, status: null, attempts: 1, error: 'Timed out' })
  const refused = await deliver('http://127.0.0.1:1/x', {}, { timeoutMs: 500, retries: 0, backoffMs: 0 })
  assert.equal(refused.ok, false)
})

test('notify only sends to enabled webhooks subscribed to the event, in their format', async () => {
  webhooks.createWebhook({ name: 'slack', url: `${base}/slack`, format: 'slack', events: ['job.failed'], enabled: true })
  webhooks.createWebhook({ name: 'success-only', url: `${base}/succ`, format: 'generic', events: ['job.succeeded'], enabled: true })
  webhooks.createWebhook({ name: 'disabled', url: `${base}/off`, format: 'generic', events: ['job.failed'], enabled: false })
  const results = await notify(jobEvent(failedJob))
  assert.equal(results.length, 1)
  assert.deepEqual(received.map((r) => r.path), ['/slack'])
  assert.match(received[0].body.text, /export failed/)
})

test('notify never throws, even when delivery fails', async () => {
  plan['/fail'] = [500]
  webhooks.createWebhook({ name: 'failing', url: `${base}/fail`, format: 'generic', events: ['job.failed'], enabled: true })
  const results = await notify(jobEvent(failedJob))
  assert.equal(results[0].ok, false)
})
