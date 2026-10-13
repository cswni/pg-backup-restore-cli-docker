const { setupTestEnv, startTestServer } = require('../test-helpers')
const env = setupTestEnv()

const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const { registerDriver } = require('../drivers')

registerDriver({
  engine: 'fake',
  kind: 'docker',
  label: 'Fake',
  fileExtension: '.sql',
  async listDatabases() { return [] },
  async dump(job, target, { outFile }) { fs.writeFileSync(outFile, 'dump') },
  async restore() {},
  async create() {},
  async drop() {},
  async unblock() {},
})

let srv
const USER_PASSWORD = 'user-password-123'
const asUser = { headers: { authorization: 'Basic ' + Buffer.from(`operator:${USER_PASSWORD}`).toString('base64') } }
const target = { serverId: 'local', engine: 'fake', container: 'pg', database: 'app' }

before(async () => {
  srv = await startTestServer()
  const res = await srv.request('POST', '/api/users', { body: { username: 'operator', password: USER_PASSWORD, role: 'user' } })
  assert.equal(res.status, 201, res.text)
})
after(() => srv.close())

const asUserRequest = (method, p, body) => srv.request(method, p, { ...asUser, noAuth: true, body })

test('user role can start a backup', async () => {
  const res = await asUserRequest('POST', '/api/ops/export', target)
  assert.equal(res.status, 200, res.text)
  assert.ok(res.json.jobId)
})

test('user role cannot restore, create, drop or unblock', async () => {
  fs.writeFileSync(path.join(env.BACKUPS_DIR, 'app.sql'), 'dump')
  for (const op of ['restore', 'create', 'delete', 'unblock']) {
    const res = await asUserRequest('POST', `/api/ops/${op}`, { ...target, file: 'app.sql' })
    assert.equal(res.status, 403, `${op}: ${res.text}`)
  }
})

test('admin can restore, create, drop and unblock', async () => {
  for (const op of ['restore', 'create', 'delete', 'unblock']) {
    const res = await srv.request('POST', `/api/ops/${op}`, { body: { ...target, file: 'app.sql' } })
    assert.equal(res.status, 200, `${op}: ${res.text}`)
  }
})

test('user role can upload but not restore the upload; the upload stays resumable', async () => {
  const init = await asUserRequest('POST', '/api/uploads', { filename: 'up.sql', size: 4 })
  assert.equal(init.status, 200, init.text)
  const id = init.json.uploadId
  await srv.request('PUT', `/api/uploads/${id}?offset=0`, {
    ...asUser, noAuth: true, raw: Buffer.from('dump'), headers: { ...asUser.headers, 'content-type': 'application/octet-stream' },
  })

  const refused = await asUserRequest('POST', `/api/uploads/${id}/complete`, { restore: true, ...target })
  assert.equal(refused.status, 403)

  const saved = await asUserRequest('POST', `/api/uploads/${id}/complete`, {})
  assert.equal(saved.status, 200, saved.text)
  assert.equal(saved.json.filename, 'up.sql')
})
