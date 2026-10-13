const { setupTestEnv, startTestServer } = require('../test-helpers')
setupTestEnv({ SCHEDULER_ENABLED: 'false', LOG_LEVEL: 'error', TZ: 'UTC' })

const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const express = require('express')
const jobs = require('../jobs')
const { registerDriver } = require('../drivers')
const scheduler = require('./index')

registerDriver({
  engine: 'fake',
  kind: 'docker',
  label: 'Fake',
  fileExtension: '.sql',
  async listDatabases() { return ['app'] },
  async dump(job, target, { database, outFile }) { fs.writeFileSync(outFile, `dump of ${database}`) },
  async restore() {},
})

const NOW = Date.parse('2026-10-12T10:30:00Z')
let srv
let roleApp

const valid = {
  name: 'Nightly app', cron: '0 2 * * *', timezone: 'UTC', serverId: 'local', engine: 'fake',
  container: 'pg', database: 'app', options: { compress: true, destinations: ['s3'] },
}

/** Minimal app mounting the scheduler router with a chosen role (permission tests). */
async function startRoleApp(role) {
  const app = express()
  app.use(express.json())
  app.use((req, res, next) => { req.user = { id: 7, username: `${role}-user`, role }; next() })
  app.use('/api', scheduler.router)
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
  const base = `http://127.0.0.1:${server.address().port}`
  const request = async (method, p, body) => {
    const res = await fetch(base + p, {
      method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined,
    })
    return { status: res.status, json: await res.json().catch(() => null) }
  }
  return { request, close: () => new Promise((r) => server.close(r)) }
}

function waitFinished(id) {
  return new Promise((resolve) => {
    if (jobs.getJob(id)?.status !== 'running') return resolve()
    const on = (s) => {
      if (s.id !== id) return
      jobs.events.removeListener('finished', on)
      setImmediate(resolve)
    }
    jobs.events.on('finished', on)
  })
}

before(async () => {
  srv = await startTestServer()
  scheduler.configureEngine({ clock: () => NOW, logger: { info() {}, warn() {}, error() {}, debug() {} } })
  roleApp = await startRoleApp('user')
})

after(async () => {
  await srv.close()
  await roleApp.close()
})

test('requires authentication', async () => {
  const res = await srv.request('GET', '/api/schedules', { noAuth: true })
  assert.equal(res.status, 401)
})

test('creates a schedule with a computed next run and lists it', async () => {
  const res = await srv.request('POST', '/api/schedules', { body: valid })
  assert.equal(res.status, 201, res.text)
  assert.equal(res.json.name, 'Nightly app')
  assert.equal(res.json.enabled, true)
  assert.equal(res.json.createdBy, 'test-admin')
  assert.deepEqual(res.json.options, valid.options)
  assert.equal(new Date(res.json.nextRunAt).toISOString(), '2026-10-13T02:00:00.000Z')

  const list = await srv.request('GET', '/api/schedules')
  const found = list.json.find((s) => s.id === res.json.id)
  assert.equal(found.overdue, false)
  assert.equal(found.lastSuccessAt, null)
})

test('defaults timezone from TZ and server to local', async () => {
  const { timezone, serverId, ...rest } = valid
  const res = await srv.request('POST', '/api/schedules', { body: { ...rest, name: 'defaults' } })
  assert.equal(res.status, 201, res.text)
  assert.equal(res.json.timezone, 'UTC')
  assert.equal(res.json.serverId, 'local')
})

test('rejects invalid input', async () => {
  const cases = [
    [{ cron: '* * * * * *' }, /5 fields/],
    [{ cron: 'every day' }, /5 fields/],
    [{ timezone: 'Mars/Base' }, /Unknown timezone/],
    [{ database: 'bad;drop' }, /Invalid database name/],
    [{ outputName: '../x' }, /Invalid output name/],
    [{ container: '' }, /container is required/],
    [{ container: 'pg; rm -rf' }, /Invalid container name/],
    [{ serverId: 'nope' }, /Unknown server/],
    [{ engine: 'oracle' }, /No driver/],
    [{ name: '' }, /name is required/],
    [{ enabled: 'yes' }, /enabled must be a boolean/],
    [{ options: [1] }, /options must be an object/],
    [{ options: { big: 'x'.repeat(5000) } }, /too large/],
  ]
  for (const [patch, re] of cases) {
    const res = await srv.request('POST', '/api/schedules', { body: { ...valid, ...patch } })
    assert.equal(res.status, 400, JSON.stringify(patch))
    assert.match(res.json.error, re)
  }
  const arr = await srv.request('POST', '/api/schedules', { body: [] })
  assert.equal(arr.status, 400)
})

test('preview returns the next 5 runs or a 400 for invalid cron', async () => {
  const ok = await srv.request('GET', '/api/schedules/preview?cron=30%203%20*%20*%201&tz=Europe/Madrid')
  assert.equal(ok.status, 200)
  assert.equal(ok.json.runs.length, 5)
  assert.equal(ok.json.runs[0], '2026-10-19T01:30:00.000Z') // Monday 03:30 CEST
  const bad = await srv.request('GET', '/api/schedules/preview?cron=nope')
  assert.equal(bad.status, 400)
  const badTz = await srv.request('GET', '/api/schedules/preview?cron=0%202%20*%20*%20*&tz=X/Y')
  assert.equal(badTz.status, 400)
})

test('partial update: disabling clears next run, re-enabling recomputes it, renaming keeps it', async () => {
  const { json: s } = await srv.request('POST', '/api/schedules', { body: { ...valid, name: 'toggle' } })
  const off = await srv.request('PUT', `/api/schedules/${s.id}`, { body: { enabled: false } })
  assert.equal(off.status, 200)
  assert.equal(off.json.enabled, false)
  assert.equal(off.json.nextRunAt, null)
  assert.equal(off.json.cron, valid.cron)

  const on = await srv.request('PUT', `/api/schedules/${s.id}`, { body: { enabled: true } })
  assert.equal(on.json.nextRunAt, s.nextRunAt)
  const renamed = await srv.request('PUT', `/api/schedules/${s.id}`, { body: { name: 'renamed' } })
  assert.equal(renamed.json.nextRunAt, s.nextRunAt)
  const hourly = await srv.request('PUT', `/api/schedules/${s.id}`, { body: { cron: '0 * * * *' } })
  assert.equal(new Date(hourly.json.nextRunAt).toISOString(), '2026-10-12T11:00:00.000Z')

  const bad = await srv.request('PUT', `/api/schedules/${s.id}`, { body: { cron: 'bad' } })
  assert.equal(bad.status, 400)
  const missing = await srv.request('PUT', '/api/schedules/missing', { body: { enabled: false } })
  assert.equal(missing.status, 404)
})

test('run now starts a backup job tagged with the schedule and records the result', async () => {
  const { json: s } = await srv.request('POST', '/api/schedules', { body: { ...valid, name: 'runnow', outputName: 'app_nightly' } })
  const res = await srv.request('POST', `/api/schedules/${s.id}/run`)
  assert.equal(res.status, 200, res.text)
  await waitFinished(res.json.jobId)

  const job = jobs.getJob(res.json.jobId)
  assert.equal(job.status, 'success')
  assert.equal(job.meta.scheduleId, s.id)
  assert.equal(job.username, 'test-admin')
  assert.match(job.meta.file, /^app_nightly_/)

  const got = await srv.request('GET', `/api/schedules/${s.id}`)
  assert.equal(got.json.lastStatus, 'success')
  assert.equal(got.json.lastJobId, res.json.jobId)
  const list = await srv.request('GET', '/api/schedules')
  assert.ok(list.json.find((x) => x.id === s.id).lastSuccessAt)
})

test('delete removes a schedule; unknown ids are 404', async () => {
  const { json: s } = await srv.request('POST', '/api/schedules', { body: { ...valid, name: 'delete-me' } })
  assert.equal((await srv.request('DELETE', `/api/schedules/${s.id}`)).status, 200)
  assert.equal((await srv.request('GET', `/api/schedules/${s.id}`)).status, 404)
  assert.equal((await srv.request('DELETE', `/api/schedules/${s.id}`)).status, 404)
  assert.equal((await srv.request('POST', `/api/schedules/${s.id}/run`)).status, 404)
})

test('non-admin users can list, preview and run, but not create, update or delete', async () => {
  const { json: s } = await srv.request('POST', '/api/schedules', { body: { ...valid, name: 'perm' } })
  assert.equal((await roleApp.request('GET', '/api/schedules')).status, 200)
  assert.equal((await roleApp.request('GET', '/api/schedules/preview?cron=0%202%20*%20*%20*')).status, 200)
  assert.equal((await roleApp.request('POST', '/api/schedules', valid)).status, 403)
  assert.equal((await roleApp.request('PUT', `/api/schedules/${s.id}`, { enabled: false })).status, 403)
  assert.equal((await roleApp.request('DELETE', `/api/schedules/${s.id}`)).status, 403)
  const run = await roleApp.request('POST', `/api/schedules/${s.id}/run`)
  assert.equal(run.status, 200)
  await waitFinished(run.json.jobId)
  assert.equal(jobs.getJob(run.json.jobId).username, 'user-user')
})
