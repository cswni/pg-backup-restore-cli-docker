const { setupTestEnv } = require('../test-helpers')
setupTestEnv({ SCHEDULER_ENABLED: 'false', LOG_LEVEL: 'error' })

const { test, before, beforeEach } = require('node:test')
const assert = require('node:assert/strict')
const jobs = require('../jobs')
const { getDb } = require('../db')
const store = require('./store')
const { createEngine, overdueReason, MISSED_GRACE_MS } = require('./engine')

const HOUR = 3600000
const T0 = Date.parse('2026-10-12T10:00:00Z')
let now = T0
let started = []
let engine

/** Fake backup starter: a real job that finishes when the test releases it. */
function fakeStart(body, user, extraMeta) {
  let release
  const done = new Promise((resolve, reject) => { release = { ok: resolve, fail: reject } })
  const id = jobs.startJob('export', { ...body, ...extraMeta }, () => done, { username: user?.username })
  started.push({ id, body, user, extraMeta, release })
  return id
}

function finished(id) {
  return new Promise((resolve) => {
    const on = (summary) => {
      if (summary.id !== id) return
      jobs.events.removeListener('finished', on)
      setImmediate(() => resolve(summary))
    }
    jobs.events.on('finished', on)
  })
}

function addSchedule(overrides = {}) {
  return store.insertSchedule({
    name: 'nightly', enabled: true, cron: '0 * * * *', timezone: 'UTC', serverId: 'local', engine: 'postgres',
    container: 'pg', database: 'app', outputName: null, options: { compress: true }, nextRunAt: T0 + HOUR,
    ...overrides,
  }, { username: 'admin' }, T0)
}

before(() => {
  jobs.init()
  store.migrateSchedules()
  jobs.events.on('finished', (s) => engine.onJobFinished(s))
})

beforeEach(() => {
  getDb().exec('DELETE FROM schedules')
  now = T0
  started = []
  engine = createEngine({ clock: () => now, startBackup: fakeStart, logger: { info() {}, warn() {}, error() {}, debug() {} } })
})

test('does nothing before a schedule is due', () => {
  addSchedule()
  engine.tick()
  assert.equal(started.length, 0)
})

test('starts a due schedule as the scheduler user and advances next_run_at', async () => {
  const s = addSchedule()
  now = T0 + HOUR + 5000
  engine.tick()
  assert.equal(started.length, 1)
  assert.deepEqual(started[0].extraMeta, { scheduleId: s.id, scheduleName: 'nightly' })
  assert.equal(started[0].user.username, 'scheduler')
  assert.deepEqual(started[0].body, {
    serverId: 'local', engine: 'postgres', container: 'pg', database: 'app', outputName: undefined, options: { compress: true },
  })
  const after = store.getSchedule(s.id)
  assert.equal(after.nextRunAt, T0 + 2 * HOUR)
  assert.equal(after.lastStatus, 'running')
  assert.equal(after.lastJobId, started[0].id)
  assert.equal(after.lastRunAt, now)

  const done = finished(started[0].id)
  started[0].release.ok()
  await done
  assert.equal(store.getSchedule(s.id).lastStatus, 'success')
})

test('after downtime, runs exactly one catch-up and does not replay missed runs', () => {
  const s = addSchedule()
  now = T0 + 5 * 24 * HOUR + 30 * 60000 // down for 5 days: ~120 hourly runs missed
  engine.tick()
  engine.tick()
  assert.equal(started.length, 1)
  assert.equal(store.getSchedule(s.id).nextRunAt, T0 + 5 * 24 * HOUR + HOUR)
})

test('skips a run while the previous run of the same schedule is still running', async () => {
  const s = addSchedule()
  now = T0 + HOUR
  engine.tick()
  now = T0 + 2 * HOUR
  engine.tick()
  assert.equal(started.length, 1, 'overlapping run must be skipped')
  assert.equal(store.getSchedule(s.id).nextRunAt, T0 + 3 * HOUR)

  const done = finished(started[0].id)
  started[0].release.fail(new Error('dump failed'))
  await done
  assert.equal(store.getSchedule(s.id).lastStatus, 'error')

  now = T0 + 3 * HOUR
  engine.tick()
  assert.equal(started.length, 2)
  const done2 = finished(started[1].id)
  started[1].release.ok()
  await done2
})

test('disabled schedules never run', () => {
  addSchedule({ enabled: false, nextRunAt: null })
  addSchedule({ name: 'stale', enabled: false, nextRunAt: T0 }) // defensive: next_run_at left behind
  now = T0 + 10 * HOUR
  engine.tick()
  assert.equal(started.length, 0)
})

test('a run that cannot start is recorded as an error and the schedule moves on', () => {
  const failing = createEngine({ clock: () => now, startBackup: () => { throw new Error('Unknown server: gone') }, logger: { info() {}, warn() {}, error() {} } })
  const s = addSchedule()
  now = T0 + HOUR
  failing.tick()
  const after = store.getSchedule(s.id)
  assert.equal(after.lastStatus, 'error')
  assert.equal(after.lastJobId, null)
  assert.equal(after.nextRunAt, T0 + 2 * HOUR)
})

test('runNow starts immediately, refuses overlap, and keeps next_run_at', async () => {
  const s = addSchedule()
  const jobId = engine.runNow(s.id, { username: 'alice' })
  assert.equal(started[0].user.username, 'alice')
  assert.equal(store.getSchedule(s.id).nextRunAt, T0 + HOUR)
  assert.throws(() => engine.runNow(s.id, { username: 'alice' }), (err) => err.status === 409)
  assert.throws(() => engine.runNow('missing', {}), (err) => err.status === 404)
  const done = finished(jobId)
  started[0].release.ok()
  await done
})

test('a finished job of an older run does not overwrite the latest status', async () => {
  const s = addSchedule()
  const first = engine.runNow(s.id, {})
  store.recordRun(s.id, { at: now, jobId: 'newer-job', status: 'running' })
  const done = finished(first)
  started[0].release.fail(new Error('x'))
  await done
  assert.equal(store.getSchedule(s.id).lastStatus, 'running')
})

test('overdueReason: healthy, never succeeded, stale success, missed run, disabled', () => {
  const base = { enabled: true, cron: '0 * * * *', timezone: 'UTC', createdAt: T0, updatedAt: T0, nextRunAt: T0 + HOUR }
  assert.equal(overdueReason(base, null, T0 + HOUR / 2), null)
  assert.match(overdueReason({ ...base, nextRunAt: T0 + 4 * HOUR }, null, T0 + 3 * HOUR), /never completed/)
  assert.match(overdueReason({ ...base, nextRunAt: T0 + 4 * HOUR }, T0, T0 + 3 * HOUR + 1), /2× its interval/)
  assert.equal(overdueReason({ ...base, nextRunAt: T0 + 4 * HOUR }, T0 + 3 * HOUR, T0 + 3.5 * HOUR), null)
  assert.match(overdueReason(base, null, T0 + HOUR + MISSED_GRACE_MS + 1), /missed/)
  assert.equal(overdueReason({ ...base, enabled: false }, null, T0 + 100 * HOUR), null)
})

test('start fills missing next_run_at for enabled schedules and stop clears the timer', () => {
  const s = addSchedule({ nextRunAt: null })
  engine.start(60000)
  engine.stop()
  assert.equal(store.getSchedule(s.id).nextRunAt, T0 + HOUR)
})
