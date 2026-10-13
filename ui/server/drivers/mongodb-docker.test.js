const path = require('path')
const { setupTestEnv } = require('../test-helpers')
const env = setupTestEnv()

const { test, mock, beforeEach } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const { installDbFakes, fakeJob } = require('./fake-db-tools')
const { buildArchive } = require('./mongodb-test-archive')
const driver = require('./mongodb-docker')
const { getDriver } = require('./index')
const { detectEngine } = require('../docker')
const { isBackupFile } = require('../catalog')
const { LOCAL_SERVER } = require('../servers')

const fakes = installDbFakes(mock, env.root, ['docker'])
const target = { server: LOCAL_SERVER, container: 'app-mongo' }

function writeArchive(namespaces) {
  const file = path.join(env.BACKUPS_DIR, `app_${Date.now()}.archive`)
  fs.writeFileSync(file, buildArchive(namespaces))
  return file
}

beforeEach(() => fakes.setState({}))

test('is registered for mongodb on docker servers, detects images and lists .archive backups', () => {
  assert.equal(getDriver('mongodb', 'docker'), driver)
  assert.equal(driver.fileExtension, '.archive')
  assert.equal(detectEngine('mongo:8.0'), 'mongodb')
  assert.equal(detectEngine('bitnami/mongodb:7'), 'mongodb')
  assert.ok(isBackupFile('app_01-01-2026_10_00_00.archive'))
  assert.equal(typeof driver.create, 'undefined')
  assert.equal(typeof driver.unblock, 'undefined')
})

test('listDatabases uses mongosh in the container and hides system databases', async () => {
  fakes.setState({ existing: ['shop', 'app'] })
  assert.deepEqual(await driver.listDatabases(target), ['app', 'shop'])
  const [call] = fakes.calls()
  assert.equal(call.cmd, 'shell')
  assert.equal(call.action, 'list')
  assert.equal(call.via.container, 'app-mongo')
})

test('the container snippet never puts the password on a command line', () => {
  const { MONGO_SH, MONGO_JS } = driver._internals
  assert.ok(!/--password/.test(MONGO_SH))
  assert.match(MONGO_SH, /--config="\$cfg"/)
  assert.match(MONGO_JS, /admin\.auth\(env\.PGUI_USER, env\.PGUI_PASSWORD\)/)
})

test('dump streams mongodump --archive --db to the file; failures remove it', async () => {
  const archive = buildArchive([['app', 'users']])
  fakes.setState({ dumpBase64: archive.toString('base64') })
  const outFile = path.join(env.BACKUPS_DIR, 'app.archive')
  await driver.dump(fakeJob(), target, { database: 'app', outFile })
  assert.deepEqual(fs.readFileSync(outFile), archive)
  const call = fakes.calls().find((c) => c.cmd === 'mongodump')
  assert.deepEqual(call.args, ['--archive', '--db=app'])

  fakes.setState({ dump: 'partial', dumpExit: 1, dumpStderr: 'Failed: auth error\n' })
  const bad = path.join(env.BACKUPS_DIR, 'bad.archive')
  await assert.rejects(driver.dump(fakeJob(), target, { database: 'app', outFile: bad }), /mongodump exited with code 1/)
  assert.equal(fs.existsSync(bad), false)
})

test('restore renames the archive source database to the target', async () => {
  fakes.setState({ collections: {} })
  const inFile = writeArchive([['app', 'users'], ['app', 'orders']])
  const job = fakeJob()
  await driver.restore(job, target, { database: 'app_qa', inFile, dropExisting: false })
  const call = fakes.calls().find((c) => c.cmd === 'mongorestore')
  assert.equal(call.interactive, true)
  assert.deepEqual(call.args, ['--archive', '--nsInclude=app.*', '--nsFrom=app.*', '--nsTo=app_qa.*', '--stopOnError'])
  assert.deepEqual(Buffer.from(call.stdinBase64, 'base64'), fs.readFileSync(inFile))
  assert.ok(job.lines.some((l) => l.text.includes("Restoring 'app' as 'app_qa'")))
})

test('restore refuses a target with collections unless dropExisting', async () => {
  fakes.setState({ collections: { app: 2 } })
  const job = fakeJob()
  await assert.rejects(driver.restore(job, target, { database: 'app', inFile: writeArchive([['app', 'users']]) }), /Drop target database/)
  assert.ok(job.lines.some((l) => l.text.includes('contains 2 collection(s)')))
  assert.equal(fakes.calls().some((c) => c.cmd === 'mongorestore'), false)

  fakes.setState({ collections: { app: 2 } })
  await driver.restore(fakeJob(), target, { database: 'app', inFile: writeArchive([['app', 'users']]), dropExisting: true })
  const calls = fakes.calls()
  assert.equal(calls[0].action, 'drop')
  assert.equal(calls[0].db, 'app')
  assert.ok(calls.some((c) => c.cmd === 'mongorestore'))
})

test('restore fails when documents fail or mongorestore exits non-zero', async () => {
  fakes.setState({ restoreStderr: '2026-01-01T00:00:00.000+0000\t1 document(s) restored successfully. 2 document(s) failed to restore.\n' })
  await assert.rejects(driver.restore(fakeJob(), target, { database: 'x', inFile: writeArchive([['app', 'u']]) }), /2 error/)
  fakes.setState({ restoreStderr: '2026-01-01T00:00:00.000+0000\tFailed: connection refused\n', restoreExit: 1 })
  await assert.rejects(driver.restore(fakeJob(), target, { database: 'x', inFile: writeArchive([['app', 'u']]) }), /mongorestore exited with code 1/)
})

test('restore rejects archives with several databases and invalid names', async () => {
  await assert.rejects(driver.restore(fakeJob(), target, { database: 'x', inFile: writeArchive([['a', 'u'], ['b', 'v']]) }), /several databases/)
  await assert.rejects(driver.restore(fakeJob(), target, { database: 'bad$name', inFile: writeArchive([['a', 'u']]) }), /Invalid MongoDB database name/)
})

test('drop runs dropDatabase through mongosh; shell errors surface', async () => {
  await driver.drop(fakeJob(), target, { database: 'old' })
  assert.deepEqual(fakes.calls().map((c) => [c.action, c.db]), [['drop', 'old']])
  fakes.setState({ shellFail: 'MongoServerError: Authentication failed.' })
  await assert.rejects(driver.listDatabases(target), /Authentication failed/)
})
