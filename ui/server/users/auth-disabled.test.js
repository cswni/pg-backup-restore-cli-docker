const { setupTestEnv, startTestServer } = require('../test-helpers')
// No credentials at all, auth explicitly disabled
setupTestEnv({ BASIC_AUTH_DISABLED: 'true', BASIC_AUTH_USER: '', BASIC_AUTH_PASSWORD: '' })

const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')

let srv
before(async () => { srv = await startTestServer() })
after(() => srv.close())

test('every request is an anonymous admin when auth is disabled', async () => {
  const res = await srv.request('GET', '/api/auth/me', { noAuth: true })
  assert.equal(res.status, 200)
  assert.equal(res.json.user.username, 'anonymous')
  assert.equal(res.json.user.role, 'admin')
  assert.equal(res.json.authDisabled, true)
  assert.equal((await srv.request('GET', '/api/users', { noAuth: true })).status, 200)
})

test('login and profile endpoints explain that auth is disabled', async () => {
  const login = await srv.request('POST', '/api/auth/login', {
    noAuth: true, body: { username: 'a', password: 'b' }, headers: { 'x-requested-with': 'pgui' },
  })
  assert.equal(login.status, 400)
  const profile = await srv.request('PUT', '/api/auth/me', { noAuth: true, body: { displayName: 'x' } })
  assert.equal(profile.status, 400)
})
