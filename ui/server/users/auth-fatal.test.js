const { setupTestEnv } = require('../test-helpers')
setupTestEnv({ BASIC_AUTH_USER: '', BASIC_AUTH_PASSWORD: '' })

const { test } = require('node:test')
const assert = require('node:assert/strict')

test('the app refuses to start with no users and no credentials', () => {
  const { createApp } = require('../app')
  assert.throws(() => createApp(), /No users exist/)
})
