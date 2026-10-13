const { setupTestEnv } = require('./test-helpers')
setupTestEnv()

const { test, before } = require('node:test')
const assert = require('node:assert/strict')
const { getDb } = require('./db')
const settings = require('./settings')

before(() => settings.init())

test('stores and reads JSON settings', () => {
  settings.setSetting('storage.compression', { enabled: true, level: 6 })
  assert.deepEqual(settings.getSetting('storage.compression'), { enabled: true, level: 6 })
  assert.equal(settings.getSetting('missing', 'default'), 'default')
})

test('secrets are encrypted at rest and only readable via getSecret', () => {
  settings.setSecret('storage.passphrase', 'correct horse')
  const raw = getDb().prepare("SELECT value FROM settings WHERE key = 'storage.passphrase'").get().value
  assert.doesNotMatch(raw, /correct horse/)
  assert.equal(settings.getSecret('storage.passphrase'), 'correct horse')
  assert.equal(settings.getSetting('storage.passphrase'), null)
  assert.equal(settings.hasSecret('storage.passphrase'), true)
})

test('deleteSetting removes a key', () => {
  settings.setSetting('tmp', 1)
  settings.deleteSetting('tmp')
  assert.equal(settings.getSetting('tmp'), null)
})
