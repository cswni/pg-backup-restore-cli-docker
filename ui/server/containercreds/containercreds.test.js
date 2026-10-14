const { setupTestEnv, startTestServer } = require('../test-helpers')
const env = setupTestEnv()

const { test, before, after, mock, beforeEach } = require('node:test')
const assert = require('node:assert/strict')
const childProcess = require('child_process')

// docker.js captures execFile when it loads, so fake `docker ps` before that.
let psOutput = ''
const realExecFile = childProcess.execFile
mock.method(childProcess, 'execFile', (cmd, args, opts, cb) => {
  if (cmd !== 'docker') return realExecFile(cmd, args, opts, cb)
  process.nextTick(() => cb(null, psOutput, ''))
})

const { getDb } = require('../db')
const store = require('./store')
const { installDbFakes } = require('../drivers/fake-db-tools')

const fakes = installDbFakes(mock, env.root, ['docker'])
const SECRET = 'very-secret-pw'
const TASK = 'legacy_legacydb.1.oznkxm16y64xdhboove8qazir'
const KEY = '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ==\n-----END OPENSSH PRIVATE KEY-----'
const base = '/api/servers/local/container-credentials'

let srv
before(async () => {
  srv = await startTestServer()
  const res = await srv.request('POST', '/api/users', { body: { username: 'viewer', password: 'user-password-1' } })
  assert.equal(res.status, 201, res.text)
})
after(() => srv.close())
beforeEach(() => {
  fakes.setState({})
  for (const c of store.listCredentials('local')) store.deleteCredentials('local', c.key)
})

const asViewer = { noAuth: true, headers: { authorization: 'Basic ' + Buffer.from('viewer:user-password-1').toString('base64') } }
const put = (key, body) => srv.request('PUT', `${base}/${key}`, { body })

test('credentialKey uses the Swarm service name for task containers', () => {
  assert.equal(store.credentialKey(TASK), 'legacy_legacydb')
  assert.equal(store.credentialKey('mcp-postgres-core'), 'mcp-postgres-core')
  assert.equal(store.credentialKey('app.1.short'), 'app.1.short')
  assert.equal(store.credentialKey('app.1.OZNKXM16Y64XDHBOOVE8QAZIR'), 'app.1.OZNKXM16Y64XDHBOOVE8QAZIR')
})

test('resolveFor matches by key, server kind and engine', () => {
  store.saveCredentials('local', 'legacy_legacydb', { engine: 'mysql', username: 'root', password: SECRET })
  const local = { id: 'local', kind: 'docker' }
  assert.equal(store.resolveFor(local, TASK).password, SECRET)
  assert.equal(store.resolveFor(local, TASK, 'mysql').username, 'root')
  assert.equal(store.resolveFor(local, TASK, 'postgres'), null)
  assert.equal(store.resolveFor(local, 'other'), null)
  assert.equal(store.resolveFor({ id: 'local', kind: 'direct' }, TASK), null)
})

test('admins save credentials; passwords are encrypted and never returned', async () => {
  const res = await put(TASK, { engine: 'mysql', username: 'root', password: SECRET })
  assert.equal(res.status, 200, res.text)
  assert.equal(res.json.key, 'legacy_legacydb')
  assert.equal(res.json.passwordConfigured, true)
  assert.equal(res.json.password, undefined)

  const list = await srv.request('GET', base)
  assert.equal(list.status, 200)
  assert.equal(list.json.length, 1)
  assert.deepEqual(Object.keys(list.json[0]).sort(), ['authSource', 'engine', 'host', 'key', 'osUser', 'passwordConfigured', 'updatedAt', 'username'])
  assert.ok(!list.text.includes(SECRET))

  const row = getDb().prepare('SELECT * FROM container_credentials WHERE key = ?').get('legacy_legacydb')
  assert.ok(row.secret.startsWith('enc:v1:'))
  assert.ok(!row.secret.includes(SECRET))
})

test('blank password keeps the stored one, null clears it', async () => {
  await put('pg-core', { engine: 'postgres', username: 'app', password: SECRET, osUser: '', host: '127.0.0.1' })
  const kept = await put('pg-core', { engine: 'postgres', username: 'app2', password: '' })
  assert.equal(kept.json.passwordConfigured, true)
  assert.equal(kept.json.username, 'app2')
  assert.equal(kept.json.osUser, '', 'missing osUser keeps the saved value')
  assert.equal(kept.json.host, null)
  assert.equal(store.getCredentials('local', 'pg-core').password, SECRET)

  const cleared = await put('pg-core', { engine: 'postgres', username: 'app2', password: null })
  assert.equal(cleared.json.passwordConfigured, false)
  assert.equal(store.getCredentials('local', 'pg-core').password, '')
})

test('engine defaults: postgres user and OS user, MySQL root, MongoDB authSource admin', async () => {
  const pg = await put('pg', { engine: 'postgres' })
  assert.deepEqual([pg.json.username, pg.json.osUser, pg.json.authSource], ['postgres', 'postgres', null])
  const my = await put('my', { engine: 'mysql', osUser: 'ignored', host: 'ignored' })
  assert.deepEqual([my.json.username, my.json.osUser, my.json.host], ['root', null, null])
  const mongo = await put('mongo', { engine: 'mongodb', username: 'ops', password: 'x' })
  assert.equal(mongo.json.authSource, 'admin')
  assert.equal((await put('mongo2', { engine: 'mongodb' })).status, 400, 'MongoDB needs a username')
})

test('validation errors are 400 with readable messages', async () => {
  const cases = [
    ['ok', { engine: 'oracle' }, /Choose an engine/],
    ['-bad', { engine: 'mysql' }, /Invalid container name/],
    ['ok', { engine: 'postgres', osUser: 'root; rm -rf /' }, /Invalid OS user/],
    ['ok', { engine: 'postgres', host: 'db host' }, /Invalid host/],
    ['ok', { engine: 'mysql', username: 'a b' }, /Invalid username/],
    ['ok', { engine: 'mysql', password: 'line\nbreak' }, /control characters/],
    ['ok', { engine: 'mongodb', username: 'u', authSource: 'bad name' }, /Invalid auth database/],
    ['ok', { engine: 'mysql', password: 42 }, /Password must be text/],
  ]
  for (const [key, body, message] of cases) {
    const res = await put(key, body)
    assert.equal(res.status, 400, `${key} ${JSON.stringify(body)}`)
    assert.match(res.json.error, message)
  }
  const socket = await put('ok', { engine: 'postgres', host: '/var/run/postgresql' })
  assert.equal(socket.json.host, '/var/run/postgresql')
})

test('unknown servers are 404, direct servers 400', async () => {
  assert.equal((await srv.request('GET', '/api/servers/nope/container-credentials')).status, 404)
  const direct = await srv.request('POST', '/api/servers', {
    body: { name: 'Direct', kind: 'direct', host: 'db.example.com', username: 'u', password: 'p' },
  })
  assert.equal(direct.status, 201, direct.text)
  const res = await srv.request('GET', `/api/servers/${direct.json.id}/container-credentials`)
  assert.equal(res.status, 400)
  assert.match(res.json.error, /Docker servers only/)
})

test('non-admins get 403 on every endpoint', async () => {
  await put('pg', { engine: 'postgres', password: SECRET })
  assert.equal((await srv.request('GET', base, asViewer)).status, 403)
  assert.equal((await srv.request('PUT', `${base}/pg`, { ...asViewer, body: { engine: 'postgres' } })).status, 403)
  assert.equal((await srv.request('DELETE', `${base}/pg`, asViewer)).status, 403)
  assert.equal((await srv.request('POST', `${base}/pg/test`, { ...asViewer, body: { container: 'pg' } })).status, 403)
  assert.ok(store.getCredentials('local', 'pg'))
})

test('delete removes saved credentials; a missing key is 404', async () => {
  await put('pg', { engine: 'postgres' })
  assert.equal((await srv.request('DELETE', `${base}/pg`)).status, 200)
  assert.equal(store.getCredentials('local', 'pg'), null)
  assert.equal((await srv.request('DELETE', `${base}/pg`)).status, 404)
})

test('test lists databases with the saved credentials and reports failures', async () => {
  await put('legacy_legacydb', { engine: 'mysql', username: 'admin', password: SECRET })
  fakes.setState({ existing: ['shop', 'crm'] })
  const ok = await srv.request('POST', `${base}/legacy_legacydb/test`, { body: { container: TASK } })
  assert.deepEqual(ok.json, { ok: true, databases: 2 })
  assert.deepEqual(fakes.calls()[0].via.env, { PGUI_DB_USER: 'admin', PGUI_DB_PASSWORD: SECRET })

  fakes.setState({ failSql: 'SHOW DATABASES' })
  const failed = await srv.request('POST', `${base}/legacy_legacydb/test`, { body: { container: TASK } })
  assert.equal(failed.status, 200)
  assert.equal(failed.json.ok, false)
  assert.match(failed.json.error, /SHOW DATABASES failed/)

  const mismatch = await srv.request('POST', `${base}/legacy_legacydb/test`, { body: { container: 'other' } })
  assert.equal(mismatch.status, 400)
  assert.equal((await srv.request('POST', `${base}/legacy_legacydb/test`, { body: {} })).status, 400)
  assert.equal((await srv.request('POST', `${base}/unsaved/test`, { body: { container: 'unsaved' } })).status, 404)
})

test('GET /api/containers adds credentialKey and credentialsConfigured', async () => {
  psOutput = [
    { ID: 'a'.repeat(64), Names: TASK, Image: 'mariadb:11', Status: 'Up', State: 'running', Labels: '', CreatedAt: 'x' },
    { ID: 'b'.repeat(64), Names: 'mcp-postgres-core', Image: 'postgres:16', Status: 'Up', State: 'running', Labels: '', CreatedAt: 'x' },
  ].map((c) => JSON.stringify(c)).join('\n')
  await put('legacy_legacydb', { engine: 'mysql', password: SECRET })
  await put('mcp-postgres-core', { engine: 'mysql', password: SECRET })
  const res = await srv.request('GET', '/api/containers', asViewer)
  assert.equal(res.status, 200, res.text)
  assert.deepEqual(res.json.map((c) => [c.name, c.credentialKey, c.credentialsConfigured]), [
    [TASK, 'legacy_legacydb', true],
    ['mcp-postgres-core', 'mcp-postgres-core', false],
  ])
  assert.ok(!res.text.includes(SECRET))
})

test('deleting a server deletes its container credentials', async () => {
  const created = await srv.request('POST', '/api/servers', {
    body: { name: 'Remote', kind: 'docker', ssh: { host: 'docker.example.com', user: 'deploy', privateKey: KEY } },
  })
  assert.equal(created.status, 201, created.text)
  const id = created.json.id
  const saved = await srv.request('PUT', `/api/servers/${id}/container-credentials/db`, { body: { engine: 'mysql', password: SECRET } })
  assert.equal(saved.status, 200, saved.text)
  assert.equal((await srv.request('DELETE', `/api/servers/${id}`)).status, 200)
  assert.deepEqual(store.listCredentials(id), [])
})
