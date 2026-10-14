const { setupTestEnv, startTestServer } = require('./test-helpers')
setupTestEnv()

const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')

let srv
before(async () => { srv = await startTestServer() })
after(() => srv.close())

test('malformed JSON bodies get a JSON 400, not an HTML error page', async () => {
  const res = await srv.request('POST', '/api/ops/export', {
    raw: '{"database": "app", "container":', headers: { 'content-type': 'application/json' },
  })
  assert.equal(res.status, 400)
  assert.deepEqual(res.json, { error: 'Request body is not valid JSON' })
  assert.doesNotMatch(res.text, /<html|at JSON\.parse/i)
})

test('unknown API routes are JSON 404s', async () => {
  const res = await srv.request('GET', '/api/does-not-exist')
  assert.equal(res.status, 404)
  assert.ok(res.json.error)
})
