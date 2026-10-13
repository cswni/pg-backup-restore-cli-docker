const { setupTestEnv, startTestServer } = require('../test-helpers')
const env = setupTestEnv()

const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')

let srv
before(async () => { srv = await startTestServer() })
after(() => srv.close())

async function init(filename, size) {
  const res = await srv.request('POST', '/api/uploads', { body: { filename, size } })
  assert.equal(res.status, 200, res.text)
  return res.json.uploadId
}

const put = (id, offset, buf) => srv.request('PUT', `/api/uploads/${id}?offset=${offset}`, {
  raw: buf, headers: { 'content-type': 'application/octet-stream' },
})

test('uploads a file in chunks and stores it in BACKUPS_DIR', async () => {
  const data = Buffer.from('CREATE TABLE t (id int);\n'.repeat(1000))
  const id = await init('premas_01-01-2026_10_00_00.sql', data.length)

  const half = Math.floor(data.length / 2)
  assert.equal((await put(id, 0, data.subarray(0, half))).json.received, half)
  assert.equal((await put(id, half, data.subarray(half))).json.received, data.length)

  const done = await srv.request('POST', `/api/uploads/${id}/complete`, { body: {} })
  assert.equal(done.status, 200, done.text)
  assert.equal(done.json.filename, 'premas_01-01-2026_10_00_00.sql')
  assert.deepEqual(fs.readFileSync(path.join(env.BACKUPS_DIR, done.json.filename)), data)
})

test('rejects a chunk at the wrong offset with the bytes already received', async () => {
  const id = await init('x.sql', 10)
  await put(id, 0, Buffer.from('12345'))
  const res = await put(id, 0, Buffer.from('12345'))
  assert.equal(res.status, 409)
  assert.equal(res.json.received, 5)
  assert.equal((await srv.request('GET', `/api/uploads/${id}`)).json.received, 5)
})

test('refuses to complete an unfinished upload', async () => {
  const id = await init('y.sql', 10)
  await put(id, 0, Buffer.from('123'))
  const res = await srv.request('POST', `/api/uploads/${id}/complete`, { body: {} })
  assert.equal(res.status, 409)
})

test('never overwrites an existing backup', async () => {
  fs.writeFileSync(path.join(env.BACKUPS_DIR, 'dup.sql'), 'old')
  const id = await init('dup.sql', 3)
  await put(id, 0, Buffer.from('new'))
  const res = await srv.request('POST', `/api/uploads/${id}/complete`, { body: {} })
  assert.match(res.json.filename, /^dup_upload_\d+\.sql$/)
  assert.equal(fs.readFileSync(path.join(env.BACKUPS_DIR, 'dup.sql'), 'utf8'), 'old')
})

test('rejects unsupported names and path traversal', async () => {
  for (const filename of ['../evil.sql', 'notes.txt', '.hidden.sql']) {
    const res = await srv.request('POST', '/api/uploads', { body: { filename, size: 1 } })
    assert.equal(res.status, 400, filename)
  }
})

test('rejects chunks beyond the declared size', async () => {
  const id = await init('z.sql', 2)
  const res = await put(id, 0, Buffer.from('too long'))
  assert.equal(res.status, 400)
})

test('requires authentication', async () => {
  const res = await srv.request('POST', '/api/uploads', { body: { filename: 'a.sql', size: 1 }, noAuth: true })
  assert.equal(res.status, 401)
})
