const { setupTestEnv } = require('../test-helpers')
const env = setupTestEnv()

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')
const { inspectArchive, parsePrelude } = require('./mongodb-archive')
const { buildArchive } = require('./mongodb-test-archive')

function write(name, buf) {
  const file = path.join(env.BACKUPS_DIR, name)
  fs.writeFileSync(file, buf)
  return file
}

test('reads the source database from the archive prelude', async () => {
  const file = write('shop.archive', buildArchive([['shop', 'orders'], ['shop', 'users']]))
  const info = await inspectArchive(file)
  assert.equal(info.gzip, false)
  assert.deepEqual(info.databases, ['shop'])
  assert.deepEqual(info.namespaces.map((n) => n.collection), ['orders', 'users'])
})

test('handles gzip archives (mongodump --gzip --archive)', async () => {
  const file = write('shop-gz.archive', zlib.gzipSync(buildArchive([['shop', 'orders']])))
  const info = await inspectArchive(file)
  assert.equal(info.gzip, true)
  assert.deepEqual(info.databases, ['shop'])
})

test('reports every database and ignores admin users/roles', async () => {
  const file = write('multi.archive', buildArchive([['a', 'x'], ['b', 'y'], ['admin', 'system.users']]))
  assert.deepEqual((await inspectArchive(file)).databases, ['a', 'b'])
})

test('empty archives have no databases', async () => {
  assert.deepEqual((await inspectArchive(write('empty.archive', buildArchive([])))).databases, [])
})

test('rejects files that are not archives and truncated preludes', async () => {
  await assert.rejects(inspectArchive(write('bad.archive', Buffer.from('-- SQL dump\n'))), /bad magic number/)
  const full = buildArchive([['shop', 'orders']])
  await assert.rejects(inspectArchive(write('cut.archive', full.subarray(0, 120))), /Truncated/)
  assert.equal(parsePrelude(full.subarray(0, 10)), null)
})
