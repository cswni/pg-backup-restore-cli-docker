const { setupTestEnv, startTestServer, TEST_USER } = require('../test-helpers')
setupTestEnv()

const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')

const CSRF = { 'x-requested-with': 'pgui' }
let srv

before(async () => { srv = await startTestServer() })
after(() => srv.close())

const basic = (u, p) => ({ noAuth: true, headers: { authorization: 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64') } })

async function create(body) {
  return srv.request('POST', '/api/users', { body: { password: 'user-password-1', ...body } })
}

async function createOk(body) {
  const res = await create(body)
  assert.equal(res.status, 201, res.text)
  return res.json
}

async function login(username, password = 'user-password-1') {
  const res = await srv.request('POST', '/api/auth/login', { body: { username, password }, noAuth: true, headers: CSRF })
  return res.headers.getSetCookie().find((c) => c.startsWith('pgui_session='))?.split(';')[0]
}

const me = async () => (await srv.request('GET', '/api/auth/me')).json.user

test('lists users without password hashes', async () => {
  const res = await srv.request('GET', '/api/users')
  assert.equal(res.status, 200)
  assert.ok(res.json.some((u) => u.username === TEST_USER && u.role === 'admin'))
  assert.doesNotMatch(res.text, /password|scrypt/i)
})

test('creates users with validation', async () => {
  const user = await createOk({ username: 'alice', displayName: 'Alice', email: 'alice@example.com' })
  assert.equal(user.role, 'user')
  assert.equal(user.disabled, false)
  assert.equal(user.password_hash, undefined)

  assert.equal((await create({ username: 'ALICE' })).status, 409)
  assert.equal((await create({ username: 'bad name' })).status, 400)
  assert.equal((await create({ username: 'bob', password: 'short' })).status, 400)
  assert.equal((await create({ username: 'bob', role: 'root' })).status, 400)
  assert.equal((await create({ username: 'bob', email: 'nope' })).status, 400)
  assert.equal((await srv.request('POST', '/api/users', { body: [] })).status, 400)
})

test('non-admins cannot manage users or delete backups but can use the app', async () => {
  await createOk({ username: 'viewer' })
  const auth = basic('viewer', 'user-password-1')
  assert.equal((await srv.request('GET', '/api/users', auth)).status, 403)
  assert.equal((await srv.request('POST', '/api/users', { ...auth, body: { username: 'x', password: 'user-password-1' } })).status, 403)
  assert.equal((await srv.request('DELETE', '/api/users/1', auth)).status, 403)
  assert.equal((await srv.request('DELETE', '/api/backups/x.sql', auth)).status, 403)
  assert.equal((await srv.request('GET', '/api/backups', auth)).status, 200)
  assert.equal((await srv.request('POST', '/api/uploads', { ...auth, body: { filename: 'v.sql', size: 1 } })).status, 200)
})

test('updates profile fields, role and disabled state', async () => {
  const u = await createOk({ username: 'carol' })
  const res = await srv.request('PUT', `/api/users/${u.id}`, { body: { displayName: 'Carol', role: 'admin', email: '' } })
  assert.equal(res.status, 200, res.text)
  assert.equal(res.json.displayName, 'Carol')
  assert.equal(res.json.role, 'admin')

  assert.equal((await srv.request('PUT', `/api/users/${u.id}`, { body: { disabled: 'yes' } })).status, 400)
  assert.equal((await srv.request('PUT', '/api/users/abc', { body: {} })).status, 400)
  assert.equal((await srv.request('PUT', '/api/users/99999', { body: {} })).status, 404)
})

test('disabling a user blocks login and revokes their sessions', async () => {
  const u = await createOk({ username: 'dave' })
  const cookie = await login('dave')
  assert.ok(cookie)
  const res = await srv.request('PUT', `/api/users/${u.id}`, { body: { disabled: true } })
  assert.equal(res.status, 200)
  assert.equal((await srv.request('GET', '/api/auth/me', { noAuth: true, headers: { cookie } })).status, 401)
  assert.equal(await login('dave'), undefined)
  assert.equal((await srv.request('GET', '/api/backups', basic('dave', 'user-password-1'))).status, 401)
})

test('admin password reset revokes the user sessions', async () => {
  const u = await createOk({ username: 'erin' })
  const cookie = await login('erin')
  assert.equal((await srv.request('PUT', `/api/users/${u.id}`, { body: { password: 'short' } })).status, 400)
  const res = await srv.request('PUT', `/api/users/${u.id}`, { body: { password: 'reset-password-1' } })
  assert.equal(res.status, 200)
  assert.equal((await srv.request('GET', '/api/auth/me', { noAuth: true, headers: { cookie } })).status, 401)
  assert.ok(await login('erin', 'reset-password-1'))
})

test('deletes users and their sessions', async () => {
  const u = await createOk({ username: 'frank' })
  const cookie = await login('frank')
  assert.equal((await srv.request('DELETE', `/api/users/${u.id}`)).status, 200)
  assert.equal((await srv.request('GET', '/api/auth/me', { noAuth: true, headers: { cookie } })).status, 401)
  assert.equal((await srv.request('DELETE', `/api/users/${u.id}`)).status, 404)
})

test('admins cannot delete or disable themselves', async () => {
  const self = await me()
  assert.equal((await srv.request('DELETE', `/api/users/${self.id}`)).status, 409)
  assert.equal((await srv.request('PUT', `/api/users/${self.id}`, { body: { disabled: true } })).status, 409)
})

test('the last active admin cannot be demoted, disabled or deleted', async () => {
  // Leave TEST_USER as the only active admin
  const users = (await srv.request('GET', '/api/users')).json
  for (const u of users.filter((x) => x.role === 'admin' && x.username !== TEST_USER)) {
    assert.equal((await srv.request('DELETE', `/api/users/${u.id}`)).status, 200)
  }
  const self = await me()
  const demote = await srv.request('PUT', `/api/users/${self.id}`, { body: { role: 'user' } })
  assert.equal(demote.status, 409)
  assert.match(demote.json.error, /last active admin/)

  // With a second admin, the first can be demoted (by the other admin)
  const other = await createOk({ username: 'grace', role: 'admin' })
  const asGrace = basic('grace', 'user-password-1')
  const res = await srv.request('PUT', `/api/users/${self.id}`, { ...asGrace, body: { role: 'user' } })
  assert.equal(res.status, 200, res.text)
  // grace is now the last admin and cannot be deleted
  assert.equal((await srv.request('DELETE', `/api/users/${other.id}`, basic('grace', 'user-password-1'))).status, 409)
  // restore TEST_USER as admin
  assert.equal((await srv.request('PUT', `/api/users/${self.id}`, { ...asGrace, body: { role: 'admin' } })).status, 200)
})
