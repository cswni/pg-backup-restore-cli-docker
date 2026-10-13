const { setupTestEnv } = require('../test-helpers')
const env = setupTestEnv()

const { test, before, beforeEach } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const jobs = require('../jobs')
const catalog = require('../catalog')
const settings = require('../settings')
const storage = require('./index')
const config = require('./config')
const destinations = require('./destinations')
const retention = require('./retention')

const DAY = 24 * 60 * 60 * 1000
const removed = []
const fakeProvider = {
  validateConfig: (c) => c,
  async upload() { return { key: 'k' } },
  async download() {},
  async remove(dest, loc) { removed.push({ dest: dest.name, key: loc.key }) },
  async test() { return { ok: true } },
}

before(() => {
  jobs.init(); catalog.init(); settings.init(); storage.init()
  destinations.setProviderForTests('s3', fakeProvider)
})

beforeEach(() => {
  for (const f of fs.readdirSync(env.BACKUPS_DIR)) fs.rmSync(path.join(env.BACKUPS_DIR, f), { recursive: true, force: true })
  for (const e of catalog.listCatalogEntries()) catalog.removeCatalogEntry(e.filename)
  for (const d of destinations.listDestinations()) destinations.deleteDestination(d.id)
  config.saveSettings({ retention: { local: { keepLast: null, keepDays: null } } })
  removed.length = 0
})

function ts(ms) {
  const d = new Date(ms)
  const p = (n) => String(n).padStart(2, '0')
  return `${p(d.getDate())}-${p(d.getMonth() + 1)}-${d.getFullYear()}_${p(d.getHours())}_${p(d.getMinutes())}_${p(d.getSeconds())}`
}

/** Create a cataloged backup `daysAgo` old; returns its filename. */
function makeBackup(db, daysAgo, { local = true, locations = [], container = 'c1' } = {}) {
  const createdAt = Date.now() - daysAgo * DAY
  const filename = `${db}_${ts(createdAt)}.sql.gz`
  if (local) fs.writeFileSync(path.join(env.BACKUPS_DIR, filename), 'x')
  catalog.recordBackup({ filename, serverId: 'local', container, sourceDatabase: db, createdAt, locations })
  return filename
}

function runInJob(work) {
  return new Promise((resolve, reject) => {
    jobs.startJob('test', {}, async (job) => {
      try { resolve({ result: await work(job), job }) } catch (err) { reject(err); throw err }
    })
  })
}

const exists = (f) => fs.existsSync(path.join(env.BACKUPS_DIR, f))

test('selectForDeletion keeps the union of rules and always the newest item', () => {
  const now = Date.now()
  const items = [0, 1, 2, 3, 4].map((d) => ({ filename: `f${d}`, createdAt: now - d * DAY - 1000 }))
  const names = (list) => list.map((i) => i.filename)
  assert.deepEqual(names(retention.selectForDeletion(items, { keepLast: 2 }, { now })), ['f2', 'f3', 'f4'])
  assert.deepEqual(names(retention.selectForDeletion(items, { keepDays: 3 }, { now })), ['f3', 'f4'])
  assert.deepEqual(names(retention.selectForDeletion(items, { keepLast: 4, keepDays: 1 }, { now })), ['f4'])
  assert.deepEqual(names(retention.selectForDeletion(items, { keepDays: 1 }, { now: now + 100 * DAY })), ['f1', 'f2', 'f3', 'f4'])
  assert.deepEqual(retention.selectForDeletion(items, { keepLast: null, keepDays: null }, { now }), [])
  assert.deepEqual(names(retention.selectForDeletion(items, { keepLast: 1 }, { now, protect: new Set(['f3']) })), ['f1', 'f2', 'f4'])
})

test('parseName reads the prefix and timestamp of pipeline file names', () => {
  const p = retention.parseName('premas_qa_05-03-2026_14_30_00.sql.gz.enc')
  assert.equal(p.prefix, 'premas_qa')
  assert.equal(p.time, new Date(2026, 2, 5, 14, 30, 0).getTime())
  assert.equal(retention.parseName('upload.sql'), null)
})

test('local keepLast applies per group; remote copies keep the catalog row', async () => {
  const a = [0, 1, 2, 3].map((d) => makeBackup('alpha', d, d === 3 ? { locations: [{ destinationId: 'gone', type: 's3', key: 'k' }] } : {}))
  const b = [0, 5].map((d) => makeBackup('beta', d))
  const other = makeBackup('alpha', 9, { container: 'c2' }) // different container → own group
  config.saveSettings({ retention: { local: { keepLast: 2 } } })

  const { result, job } = await runInJob((j) => retention.runRetention(j))
  assert.equal(result, 2)
  assert.deepEqual(a.map(exists), [true, true, false, false])
  assert.deepEqual(b.map(exists), [true, true])
  assert.equal(exists(other), true)
  assert.equal(catalog.getCatalogEntry(a[2]), null, 'row without copies removed')
  const remoteOnly = catalog.listBackups().find((x) => x.name === a[3])
  assert.equal(remoteOnly.local, false)
  assert.ok(job.lines.some((l) => l.text.includes(`Deleted local file ${a[2]}`)))
})

test('keepDays never deletes the newest copy of a group', async () => {
  const files = [10, 20].map((d) => makeBackup('gamma', d))
  config.saveSettings({ retention: { local: { keepDays: 1 } } })
  await runInJob((j) => retention.runRetention(j))
  assert.deepEqual(files.map(exists), [true, false])
})

test('uncataloged files are only touched when the prefix matches exactly one group', async () => {
  makeBackup('delta', 0)
  const orphanOld = `delta_${ts(Date.now() - 40 * DAY)}.sql`
  const unrelated = `zeta_${ts(Date.now() - 40 * DAY)}.sql`
  const upload = 'delta_upload_123.sql'
  for (const f of [orphanOld, unrelated, upload]) fs.writeFileSync(path.join(env.BACKUPS_DIR, f), 'x')
  config.saveSettings({ retention: { local: { keepDays: 7 } } })
  await runInJob((j) => retention.runRetention(j))
  assert.equal(exists(orphanOld), false)
  assert.equal(exists(unrelated), true)
  assert.equal(exists(upload), true)
})

test('destination retention deletes remote copies and updates the catalog', async () => {
  const dest = destinations.insertDestination({ type: 's3', name: 'cloud', config: {}, retention: { keepLast: 1 } })
  const loc = (key) => [{ destinationId: dest.id, type: 's3', key }]
  const newest = makeBackup('eps', 0, { locations: loc('k0') })
  const older = makeBackup('eps', 1, { locations: loc('k1') })
  const remoteOnly = makeBackup('eps', 2, { local: false, locations: loc('k2') })

  await runInJob((j) => retention.runRetention(j))
  assert.deepEqual(removed.map((r) => r.key).sort(), ['k1', 'k2'])
  assert.deepEqual(catalog.getCatalogEntry(newest).locations.length, 1)
  assert.deepEqual(catalog.getCatalogEntry(older).locations, [])
  assert.equal(exists(older), true, 'local copy untouched by destination policy')
  assert.equal(catalog.getCatalogEntry(remoteOnly), null, 'no copies left → row removed')
})

test('the retention step protects the backup being created', async () => {
  makeBackup('eta', -1) // a "newer" backup (clock skew) so the new one is not the newest
  const current = path.join(env.BACKUPS_DIR, `eta_${ts(Date.now())}.sql.gz`)
  fs.writeFileSync(current, 'x')
  config.saveSettings({ retention: { local: { keepLast: 1 } } })
  await runInJob((j) => retention.retentionStep({
    file: current, server: { id: 'local' }, container: 'c1', database: 'eta', locations: [],
  }, j))
  assert.equal(fs.existsSync(current), true)
})

test('startSweep returns null without policies and a job id otherwise', async () => {
  assert.equal(retention.startSweep('manual'), null)
  config.saveSettings({ retention: { local: { keepLast: 3 } } })
  const id = retention.startSweep('manual')
  assert.ok(id)
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(jobs.getJob(id).type, 'retention')
})
