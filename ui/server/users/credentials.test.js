const { setupTestEnv } = require('../test-helpers')
setupTestEnv()

const { test, beforeEach } = require('node:test')
const assert = require('node:assert/strict')
const store = require('./store')
const { hashPasswordSync } = require('./passwords')
const { checkCredentials, resetLimiterForTests } = require('./credentials')

const PASSWORD = 'correct-horse-battery'
store.initSchema()
const user = store.createUser({ username: 'alice', passwordHash: hashPasswordSync(PASSWORD), role: 'user' })

beforeEach(() => resetLimiterForTests())

test('per-account limit holds even when every attempt claims a different IP', async () => {
  for (let i = 0; i < 20; i++) {
    const r = await checkCredentials('alice', 'wrong-password', `10.0.0.${i}`)
    assert.equal(r.status, 401, `attempt ${i}`)
  }
  const blocked = await checkCredentials('alice', PASSWORD, '10.9.9.9')
  assert.equal(blocked.status, 429)
  assert.ok(blocked.retryAfter > 0)
})

test('per-IP limit stops spraying many usernames from one address', async () => {
  for (let i = 0; i < 50; i++) await checkCredentials(`nobody${i}`, 'x', '192.0.2.1')
  const blocked = await checkCredentials('alice', PASSWORD, '192.0.2.1')
  assert.equal(blocked.status, 429)
  const other = await checkCredentials('alice', PASSWORD, '192.0.2.2')
  assert.equal(other.ok, true)
})

test('caps concurrent password verifications', async () => {
  const results = await Promise.all(
    Array.from({ length: 6 }, (_, i) => checkCredentials(`ghost${i}`, 'x', `198.51.100.${i}`))
  )
  assert.ok(results.some((r) => r.status === 429), 'some attempts are shed with 429')
})

test('a cached verification is invalidated by a password change or disable', async () => {
  assert.equal((await checkCredentials('alice', PASSWORD, '203.0.113.1')).ok, true)
  assert.equal((await checkCredentials('alice', PASSWORD, '203.0.113.1')).ok, true) // cache hit

  store.updateUser(user.id, { passwordHash: hashPasswordSync('a-brand-new-password') })
  assert.equal((await checkCredentials('alice', PASSWORD, '203.0.113.1')).ok, false)

  store.updateUser(user.id, { passwordHash: hashPasswordSync(PASSWORD), disabled: true })
  assert.equal((await checkCredentials('alice', PASSWORD, '203.0.113.1')).ok, false)
})
