const { setupTestEnv, startTestServer } = require('../test-helpers')
const env = setupTestEnv()
delete process.env.BACKUP_ENCRYPTION_PASSPHRASE
delete process.env.PUBLIC_URL

const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const express = require('express')
const { getDb } = require('../db')
const catalog = require('../catalog')
const { startFakeS3 } = require('./test-fakes')

let srv
let s3
before(async () => {
  s3 = await startFakeS3()
  srv = await startTestServer()
})
after(async () => { await srv.close(); await s3.close() })

const s3Body = (extra = {}) => ({
  type: 's3',
  name: 'Fake S3',
  config: { endpoint: s3.url, bucket: 'bkt', prefix: '/team/backups', accessKeyId: 'AKID', secretAccessKey: 'shh-secret', forcePathStyle: true },
  ...extra,
})

test('settings: defaults, validation and write-only passphrase', async () => {
  const res = await srv.request('GET', '/api/storage/settings')
  assert.equal(res.status, 200)
  assert.deepEqual(res.json.compression, { enabled: true, level: 6 })
  assert.equal(res.json.encryption.passphraseConfigured, false)
  assert.match(res.json.gdriveRedirectUri, /^http:\/\/127\.0\.0\.1:\d+\/api\/storage\/gdrive\/oauth\/callback$/)

  for (const [body, message] of [
    [{ compression: { level: 12 } }, /^Compression level must be a whole number from 1 to 9$/],
    [{ compression: { enabled: 'yes' } }, /^Compress new backups by default must be true or false$/],
    [{ encryption: { enabled: true } }, /^Set an encryption passphrase/],
    [{ encryption: { passphrase: 'short' } }, /^Passphrase must be \d+ to 1024 characters$/],
    [{ upload: { failurePolicy: 'maybe' } }, /^Upload failure policy must be 'fail' or 'best-effort'$/],
    [{ retention: { local: { keepLast: -1 } } }, /^Local retention: Newest N must be a whole number/],
    [{ retention: 'x' }, /must be an object/],
  ]) {
    const bad = await srv.request('PUT', '/api/storage/settings', { body })
    assert.equal(bad.status, 400, JSON.stringify(body))
    assert.match(bad.json.error, message)
  }

  const ok = await srv.request('PUT', '/api/storage/settings', {
    body: { compression: { level: 9 }, encryption: { enabled: true, passphrase: 'correct horse battery' }, retention: { local: { keepLast: 7, keepDays: '' } } },
  })
  assert.equal(ok.status, 200, ok.text)
  assert.equal(ok.json.compression.level, 9)
  assert.equal(ok.json.encryption.enabled, true)
  assert.equal(ok.json.encryption.passphraseSource, 'settings')
  assert.deepEqual(ok.json.retention.local, { keepLast: 7, keepDays: null })
  assert.doesNotMatch(ok.text, /correct horse/)
  const raw = getDb().prepare("SELECT value FROM settings WHERE key = 'storage.encryption.passphrase'").get().value
  assert.doesNotMatch(raw, /correct horse/)
})

test('settings: replacing the passphrase keeps the previous one', async () => {
  const res = await srv.request('PUT', '/api/storage/settings', { body: { encryption: { passphrase: 'second long passphrase' } } })
  assert.equal(res.json.encryption.previousPassphrases, 1)
})

test('settings: an invalid section does not partially apply the others', async () => {
  const bad = await srv.request('PUT', '/api/storage/settings', { body: { compression: { level: 2 }, upload: { failurePolicy: 'bad' } } })
  assert.equal(bad.status, 400)
  const now = await srv.request('GET', '/api/storage/settings')
  assert.equal(now.json.compression.level, 9)
})

test('destinations: create masks secrets, update keeps them when blank', async () => {
  const created = await srv.request('POST', '/api/storage/destinations', { body: s3Body({ isDefault: true }) })
  assert.equal(created.status, 201, created.text)
  assert.doesNotMatch(created.text, /shh-secret/)
  assert.equal(created.json.config.prefix, 'team/backups/')
  assert.deepEqual(created.json.secrets, { secretAccessKey: true })
  const id = created.json.id

  const updated = await srv.request('PUT', `/api/storage/destinations/${id}`, {
    body: { name: 'Renamed', config: { ...s3Body().config, secretAccessKey: '' }, retention: { keepDays: 30 } },
  })
  assert.equal(updated.status, 200, updated.text)
  assert.equal(updated.json.name, 'Renamed')
  assert.equal(updated.json.isDefault, true, 'unchanged when omitted')
  assert.deepEqual(updated.json.retention, { keepLast: null, keepDays: 30 })

  const tested = await srv.request('POST', `/api/storage/destinations/${id}/test`)
  assert.equal(tested.json.ok, true, tested.text)
  assert.ok(s3.state.requests.some((r) => r.method === 'PUT' && r.key.startsWith('bkt/team/backups/.pgbackup-probe-')))
  assert.equal(s3.state.objects.size, 0, 'probe deleted')
})

test('destinations: validation errors', async () => {
  const cases = [
    [{ type: 'ftp', name: 'x' }, /^Destination type must be one of/],
    [s3Body({ name: '' }), /^Name is required/],
    [s3Body({ config: { bucket: 'bkt' } }), /^Secret access key is required$/],
    [s3Body({ config: { ...s3Body().config, endpoint: 'file:///etc/passwd' } }), /^Endpoint must start with http/],
    [s3Body({ config: { ...s3Body().config, prefix: '../escape' } }), /^Prefix contains unsupported characters$/],
    [s3Body({ retention: { keepLast: 1.5 } }), /^Retention: Newest N must be a whole number/],
    [{ type: 'gdrive', name: 'd', config: { clientId: 'cid' } }, /^OAuth client secret is required$/],
    [{ type: 'gdrive', name: 'd', config: {} }, /^OAuth client ID is required$/],
  ]
  for (const [body, message] of cases) {
    const res = await srv.request('POST', '/api/storage/destinations', { body })
    assert.equal(res.status, 400, JSON.stringify(body))
    assert.match(res.json.error, message)
  }
  assert.equal((await srv.request('PUT', '/api/storage/destinations/nope', { body: s3Body() })).status, 404)
})

test('defaults endpoint feeds the export modal', async () => {
  const res = await srv.request('GET', '/api/storage/defaults')
  assert.equal(res.json.compress, true)
  assert.equal(res.json.encrypt, true)
  assert.equal(res.json.encryptionAvailable, true)
  assert.equal(res.json.destinations.length, 1)
  assert.deepEqual(Object.keys(res.json.destinations[0]).sort(), ['id', 'isDefault', 'name', 'ready', 'type'])
})

test('deleting a destination forgets its copies in the catalog', async () => {
  const created = await srv.request('POST', '/api/storage/destinations', { body: s3Body({ name: 'temp' }) })
  const id = created.json.id
  const loc = { destinationId: id, type: 's3', key: 'k' }
  catalog.recordBackup({ filename: 'only_remote.sql.gz', sourceDatabase: 'x', locations: [loc] })
  fs.writeFileSync(path.join(env.BACKUPS_DIR, 'both.sql.gz'), 'x')
  catalog.recordBackup({ filename: 'both.sql.gz', sourceDatabase: 'x', locations: [loc] })

  const res = await srv.request('DELETE', `/api/storage/destinations/${id}`)
  assert.equal(res.status, 200)
  assert.equal(catalog.getCatalogEntry('only_remote.sql.gz'), null)
  assert.deepEqual(catalog.getCatalogEntry('both.sql.gz').locations, [])
})

test('remote copies can be deleted; remote-only rows disappear', async () => {
  const created = await srv.request('POST', '/api/storage/destinations', { body: s3Body({ name: 'del' }) })
  s3.state.objects.set('bkt/team/backups/r.sql.gz', Buffer.from('x'))
  catalog.recordBackup({ filename: 'r.sql.gz', sourceDatabase: 'x', locations: [{ destinationId: created.json.id, type: 's3', key: 'team/backups/r.sql.gz' }] })
  assert.equal((await srv.request('GET', '/api/backups')).json.find((b) => b.name === 'r.sql.gz').local, false)

  const res = await srv.request('DELETE', '/api/storage/backups/r.sql.gz/remote')
  assert.equal(res.status, 200, res.text)
  assert.equal(s3.state.objects.has('bkt/team/backups/r.sql.gz'), false)
  assert.equal(catalog.getCatalogEntry('r.sql.gz'), null)
  assert.equal((await srv.request('DELETE', '/api/storage/backups/r.sql.gz/remote')).status, 404)
  assert.equal((await srv.request('DELETE', '/api/storage/backups/..%2Fetc.sql/remote')).status, 400)
})

test('retention can be run on demand', async () => {
  const res = await srv.request('POST', '/api/storage/retention/run')
  assert.equal(res.status, 200, res.text)
  assert.ok(res.json.jobId)
})

test('non-admin users only get the read endpoints, without config', async () => {
  const { router } = require('./index')
  const app = express()
  app.use(express.json())
  app.use((req, res, next) => { req.user = { id: 2, username: 'viewer', role: 'user' }; next() })
  app.use('/api', router)
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)) })
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    const list = await (await fetch(`${base}/api/storage/destinations`)).json()
    assert.ok(list.length > 0)
    assert.equal(list[0].config, undefined)
    assert.equal((await fetch(`${base}/api/storage/defaults`)).status, 200)
    for (const [method, p] of [['GET', '/storage/settings'], ['PUT', '/storage/settings'], ['POST', '/storage/destinations'],
      ['POST', `/storage/destinations/${list[0].id}/test`], ['DELETE', `/storage/destinations/${list[0].id}`],
      ['GET', `/storage/gdrive/${list[0].id}/connect`], ['POST', '/storage/retention/run']]) {
      const res = await fetch(`${base}/api${p}`, { method, redirect: 'manual' })
      assert.equal(res.status, 403, `${method} ${p}`)
    }
  } finally {
    await new Promise((r) => server.close(r))
  }
})

test('environment passphrase wins and is reported as such', async () => {
  process.env.BACKUP_ENCRYPTION_PASSPHRASE = 'from-the-environment'
  try {
    const res = await srv.request('GET', '/api/storage/settings')
    assert.equal(res.json.encryption.passphraseSource, 'env')
    assert.equal(require('./config').currentPassphrase(), 'from-the-environment')
  } finally {
    delete process.env.BACKUP_ENCRYPTION_PASSPHRASE
  }
})
