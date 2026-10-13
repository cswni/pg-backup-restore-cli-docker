const { setupTestEnv } = require('../test-helpers')
setupTestEnv()

const { test, beforeEach } = require('node:test')
const assert = require('node:assert/strict')
const { resetDbForTests } = require('../db')
const store = require('./store')
const { bootstrapAuth } = require('./bootstrap')
const { verifyPassword } = require('./passwords')

const quiet = { log() {}, warn() {} }

beforeEach(() => { resetDbForTests() })

test('creates the first admin from BASIC_AUTH_* credentials', async () => {
  const res = bootstrapAuth({ BASIC_AUTH_USER: 'boss', BASIC_AUTH_PASSWORD: 'super-secret-1' }, quiet)
  assert.deepEqual(res, { disabled: false, created: true })
  const row = store.findForLogin('BOSS')
  assert.equal(row.role, 'admin')
  assert.equal(await verifyPassword('super-secret-1', row.password_hash), true)
})

test('ADMIN_* take precedence over BASIC_AUTH_*', () => {
  bootstrapAuth({
    BASIC_AUTH_USER: 'old', BASIC_AUTH_PASSWORD: 'old-password-1',
    ADMIN_USER: 'new', ADMIN_PASSWORD: 'new-password-1',
  }, quiet)
  assert.ok(store.findForLogin('new'))
  assert.equal(store.findForLogin('old'), null)
})

test('fails closed with no users and no credentials', () => {
  assert.throws(() => bootstrapAuth({}, quiet), /No users exist/)
  assert.throws(() => bootstrapAuth({ BASIC_AUTH_USER: 'x' }, quiet), /No users exist/)
})

test('starts without credentials when auth is explicitly disabled', () => {
  assert.deepEqual(bootstrapAuth({ BASIC_AUTH_DISABLED: 'true' }, quiet), { disabled: true, created: false })
  assert.equal(store.countUsers(), 0)
})

test('rejects an invalid initial username', () => {
  assert.throws(() => bootstrapAuth({ BASIC_AUTH_USER: 'bad user', BASIC_AUTH_PASSWORD: 'long-enough-1' }, quiet), /Invalid initial admin/)
})

test('warns but still bootstraps a short legacy password', () => {
  const warnings = []
  bootstrapAuth({ BASIC_AUTH_USER: 'a', BASIC_AUTH_PASSWORD: 'short' }, { log() {}, warn: (m) => warnings.push(m) })
  assert.equal(store.countUsers(), 1)
  assert.equal(warnings.length, 1)
})

test('never overwrites an existing user when env credentials change', async () => {
  bootstrapAuth({ BASIC_AUTH_USER: 'boss', BASIC_AUTH_PASSWORD: 'first-password' }, quiet)
  const res = bootstrapAuth({ BASIC_AUTH_USER: 'boss', BASIC_AUTH_PASSWORD: 'second-password' }, quiet)
  assert.equal(res.created, false)
  const row = store.findForLogin('boss')
  assert.equal(await verifyPassword('first-password', row.password_hash), true)
  assert.equal(await verifyPassword('second-password', row.password_hash), false)
  // Existing users also mean no credentials are needed any more
  assert.equal(bootstrapAuth({}, quiet).created, false)
})
