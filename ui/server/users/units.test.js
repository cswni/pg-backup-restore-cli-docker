const { setupTestEnv } = require('../test-helpers')
setupTestEnv()

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { hashPassword, hashPasswordSync, verifyPassword, verifyDummy, passwordPolicyError } = require('./passwords')
const { createLimiter, limiterKey } = require('./rate-limit')
const { parseBasicAuth } = require('../auth')
const { readCookie } = require('./sessions')

test('hashes with a random salt and verifies in constant time', async () => {
  const a = await hashPassword('correct horse battery')
  const b = hashPasswordSync('correct horse battery')
  assert.notEqual(a, b)
  assert.match(a, /^scrypt\$32768\$8\$1\$/)
  assert.equal(await verifyPassword('correct horse battery', a), true)
  assert.equal(await verifyPassword('correct horse battery', b), true)
  assert.equal(await verifyPassword('wrong password!', a), false)
})

test('rejects malformed hashes and non-string passwords', async () => {
  assert.equal(await verifyPassword('x', 'plain'), false)
  assert.equal(await verifyPassword('x', 'scrypt$a$b$c$d$e'), false)
  assert.equal(await verifyPassword(undefined, await hashPassword('0123456789')), false)
  assert.equal(await verifyDummy('anything'), false)
})

test('password policy requires at least 10 characters', () => {
  assert.match(passwordPolicyError('short'), /at least 10/)
  assert.match(passwordPolicyError(undefined), /required/)
  assert.match(passwordPolicyError('x'.repeat(2000)), /at most/)
  assert.equal(passwordPolicyError('0123456789'), null)
})

test('limiter blocks after max failures until the window ends', () => {
  let t = 0
  const limiter = createLimiter({ maxFailures: 3, windowMs: 60000, now: () => t })
  const key = limiterKey('Admin', '1.2.3.4')
  assert.equal(key, 'admin|1.2.3.4')
  for (let i = 0; i < 3; i++) {
    assert.equal(limiter.retryAfter(key), 0)
    limiter.fail(key)
  }
  assert.equal(limiter.retryAfter(key), 60)
  assert.equal(limiter.retryAfter(limiterKey('admin', '5.6.7.8')), 0)
  t = 30000
  assert.equal(limiter.retryAfter(key), 30)
  t = 60000
  assert.equal(limiter.retryAfter(key), 0)
})

test('limiter reset clears failures', () => {
  const limiter = createLimiter({ maxFailures: 1 })
  limiter.fail('k')
  assert.ok(limiter.retryAfter('k') > 0)
  limiter.reset('k')
  assert.equal(limiter.retryAfter('k'), 0)
})

test('parses Basic credentials, including passwords with colons', () => {
  const header = 'Basic ' + Buffer.from('bob:pa:ss').toString('base64')
  assert.deepEqual(parseBasicAuth(header), { username: 'bob', password: 'pa:ss' })
  assert.equal(parseBasicAuth('Bearer abc'), null)
  assert.equal(parseBasicAuth('Basic ' + Buffer.from('nocolon').toString('base64')), null)
  assert.equal(parseBasicAuth(undefined), null)
})

test('reads a cookie from the Cookie header', () => {
  const req = { headers: { cookie: 'a=1; pgui_session=abc%2Fdef; b=2' } }
  assert.equal(readCookie(req, 'pgui_session'), 'abc/def')
  assert.equal(readCookie(req, 'missing'), null)
  assert.equal(readCookie({ headers: {} }, 'a'), null)
})
