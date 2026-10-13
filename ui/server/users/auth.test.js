const { setupTestEnv, startTestServer, TEST_USER, TEST_PASSWORD } = require('../test-helpers')
setupTestEnv()

const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')

const CSRF = { 'x-requested-with': 'pgui' }
let srv

before(async () => { srv = await startTestServer() })
after(() => srv.close())

const basic = (u, p) => 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64')

async function login(username, password) {
  const res = await srv.request('POST', '/api/auth/login', { body: { username, password }, noAuth: true, headers: CSRF })
  const setCookie = res.headers.getSetCookie().find((c) => c.startsWith('pgui_session='))
  return { res, setCookie, cookie: setCookie?.split(';')[0] }
}

/** Request options authenticated by cookie only. */
const withCookie = (cookie, opts = {}) => ({ ...opts, noAuth: true, headers: { cookie, ...(opts.headers ?? {}) } })

async function createUser(username, password = 'user-password-1', role = 'user') {
  const res = await srv.request('POST', '/api/users', { body: { username, password, role } })
  assert.equal(res.status, 201, res.text)
  return res.json
}

test('API requires authentication and never sends WWW-Authenticate', async () => {
  const res = await srv.request('GET', '/api/backups', { noAuth: true })
  assert.equal(res.status, 401)
  assert.equal(res.headers.get('www-authenticate'), null)
  assert.equal(res.json.error, 'Authentication required')
})

test('the SPA (non-API paths) is served without auth', async () => {
  const res = await srv.request('GET', '/login', { noAuth: true })
  assert.notEqual(res.status, 401)
})

test('wrong Basic credentials are rejected with JSON 401', async () => {
  const res = await srv.request('GET', '/api/backups', { noAuth: true, headers: { authorization: basic(TEST_USER, 'nope-nope-nope') } })
  assert.equal(res.status, 401)
  assert.equal(res.headers.get('www-authenticate'), null)
})

test('login sets a hardened session cookie and /me returns the user', async () => {
  const { res, setCookie, cookie } = await login(TEST_USER, TEST_PASSWORD)
  assert.equal(res.status, 200, res.text)
  assert.equal(res.json.user.username, TEST_USER)
  assert.equal(res.json.user.password_hash, undefined)
  assert.match(setCookie, /HttpOnly/i)
  assert.match(setCookie, /SameSite=Lax/i)
  assert.match(setCookie, /Path=\//)
  assert.match(setCookie, /Max-Age=604800/)

  const me = await srv.request('GET', '/api/auth/me', withCookie(cookie))
  assert.equal(me.status, 200)
  assert.equal(me.json.user.role, 'admin')
  assert.equal(me.json.authMethod, 'session')
  assert.ok(me.json.user.lastLoginAt > 0)
})

test('login is case-insensitive on the username', async () => {
  const { res } = await login(TEST_USER.toUpperCase(), TEST_PASSWORD)
  assert.equal(res.status, 200)
})

test('login validates input and requires the CSRF header', async () => {
  const missing = await srv.request('POST', '/api/auth/login', { body: { username: 'x' }, noAuth: true, headers: CSRF })
  assert.equal(missing.status, 400)
  const noHeader = await srv.request('POST', '/api/auth/login', { body: { username: TEST_USER, password: TEST_PASSWORD }, noAuth: true })
  assert.equal(noHeader.status, 403)
})

test('cookie-authenticated unsafe requests need X-Requested-With', async () => {
  const { cookie } = await login(TEST_USER, TEST_PASSWORD)
  const body = { filename: 'a.sql', size: 1 }
  const blocked = await srv.request('POST', '/api/uploads', withCookie(cookie, { body }))
  assert.equal(blocked.status, 403)
  const ok = await srv.request('POST', '/api/uploads', withCookie(cookie, { body, headers: CSRF }))
  assert.equal(ok.status, 200, ok.text)
  // GET needs no header
  assert.equal((await srv.request('GET', '/api/backups', withCookie(cookie))).status, 200)
})

test('cross-site browser requests are refused even with the header', async () => {
  const { cookie } = await login(TEST_USER, TEST_PASSWORD)
  const res = await srv.request('POST', '/api/uploads', withCookie(cookie, {
    body: { filename: 'a.sql', size: 1 }, headers: { ...CSRF, 'sec-fetch-site': 'cross-site' },
  }))
  assert.equal(res.status, 403)
  const viaBasic = await srv.request('POST', '/api/uploads', {
    body: { filename: 'a.sql', size: 1 }, headers: { 'sec-fetch-site': 'cross-site' },
  })
  assert.equal(viaBasic.status, 403)
})

test('Basic auth requests do not need the CSRF header', async () => {
  const res = await srv.request('POST', '/api/uploads', { body: { filename: 'b.sql', size: 1 } })
  assert.equal(res.status, 200, res.text)
})

test('logout revokes the session and clears the cookie', async () => {
  const { cookie } = await login(TEST_USER, TEST_PASSWORD)
  const out = await srv.request('POST', '/api/auth/logout', withCookie(cookie, { headers: CSRF }))
  assert.equal(out.status, 200)
  assert.match(out.headers.getSetCookie().join(';'), /pgui_session=;/)
  const me = await srv.request('GET', '/api/auth/me', withCookie(cookie))
  assert.equal(me.status, 401)
})

test('an unknown session token is rejected and cleared', async () => {
  const res = await srv.request('GET', '/api/auth/me', withCookie('pgui_session=forged'))
  assert.equal(res.status, 401)
  assert.match(res.headers.getSetCookie().join(';'), /pgui_session=;/)
})

test('users can edit their own profile', async () => {
  await createUser('profile-user')
  const { cookie } = await login('profile-user', 'user-password-1')
  const res = await srv.request('PUT', '/api/auth/me', withCookie(cookie, {
    body: { displayName: '  Pat Doe ', email: 'pat@example.com', role: 'admin' }, headers: CSRF,
  }))
  assert.equal(res.status, 200, res.text)
  assert.equal(res.json.user.displayName, 'Pat Doe')
  assert.equal(res.json.user.email, 'pat@example.com')
  assert.equal(res.json.user.role, 'user') // role is not self-editable

  const bad = await srv.request('PUT', '/api/auth/me', withCookie(cookie, { body: { email: 'not-an-email' }, headers: CSRF }))
  assert.equal(bad.status, 400)
})

test('password change checks the current password and revokes other sessions', async () => {
  await createUser('pw-user')
  const first = await login('pw-user', 'user-password-1')
  const second = await login('pw-user', 'user-password-1')
  const change = (body) => srv.request('PUT', '/api/auth/me/password', withCookie(first.cookie, { body, headers: CSRF }))

  assert.equal((await change({ currentPassword: 'wrong-password', newPassword: 'new-password-1' })).status, 400)
  assert.equal((await change({ currentPassword: 'user-password-1', newPassword: 'short' })).status, 400)
  const ok = await change({ currentPassword: 'user-password-1', newPassword: 'new-password-1' })
  assert.equal(ok.status, 200, ok.text)

  assert.equal((await srv.request('GET', '/api/auth/me', withCookie(first.cookie))).status, 200)
  assert.equal((await srv.request('GET', '/api/auth/me', withCookie(second.cookie))).status, 401)
  assert.equal((await login('pw-user', 'user-password-1')).res.status, 401)
  assert.equal((await login('pw-user', 'new-password-1')).res.status, 200)
})

test('Basic auth works for any user in the users table', async () => {
  await createUser('script-user')
  const res = await srv.request('GET', '/api/auth/me', { noAuth: true, headers: { authorization: basic('script-user', 'user-password-1') } })
  assert.equal(res.status, 200)
  assert.equal(res.json.authMethod, 'basic')
  assert.equal(res.json.user.role, 'user')
})

test('repeated login failures are rate limited with Retry-After', async () => {
  await createUser('brute-user')
  for (let i = 0; i < 5; i++) assert.equal((await login('brute-user', 'wrong-password')).res.status, 401)
  const blocked = await login('brute-user', 'user-password-1')
  assert.equal(blocked.res.status, 429)
  assert.ok(Number(blocked.res.headers.get('retry-after')) > 0)
  // Basic auth shares the limiter
  const viaBasic = await srv.request('GET', '/api/backups', { noAuth: true, headers: { authorization: basic('brute-user', 'user-password-1') } })
  assert.equal(viaBasic.status, 429)
})

test('failed Basic attempts count towards the limit', async () => {
  await createUser('basic-brute')
  const bad = { noAuth: true, headers: { authorization: basic('basic-brute', 'wrong-password') } }
  for (let i = 0; i < 5; i++) assert.equal((await srv.request('GET', '/api/backups', bad)).status, 401)
  assert.equal((await srv.request('GET', '/api/backups', bad)).status, 429)
})

test('unknown usernames fail like wrong passwords', async () => {
  const { res } = await login('no-such-user', 'whatever-123')
  assert.equal(res.status, 401)
  assert.equal(res.json.error, 'Invalid username or password')
})
