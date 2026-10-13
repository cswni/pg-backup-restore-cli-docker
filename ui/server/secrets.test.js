const { setupTestEnv } = require('./test-helpers')
setupTestEnv()

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { encrypt, decrypt, setKeyForTests } = require('./secrets')

test('encrypts and decrypts round-trip with a random IV', () => {
  const a = encrypt('s3cret')
  const b = encrypt('s3cret')
  assert.notEqual(a, b)
  assert.match(a, /^enc:v1:/)
  assert.equal(decrypt(a), 's3cret')
})

test('passes through empty and plaintext values', () => {
  assert.equal(encrypt(''), '')
  assert.equal(encrypt(null), null)
  assert.equal(decrypt('plain'), 'plain')
})

test('fails with a different key (authenticated encryption)', () => {
  const value = encrypt('s3cret')
  setKeyForTests('another-key')
  assert.throws(() => decrypt(value))
})
