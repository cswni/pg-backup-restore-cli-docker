const path = require('path')
const { setupTestEnv } = require('../test-helpers')
const env = setupTestEnv()

const { test, mock, beforeEach } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const { installDbFakes, fakeJob } = require('./fake-db-tools')
const { buildArchive } = require('./mongodb-test-archive')
const driver = require('./mongodb-direct')
const { getDriver } = require('./index')

const fakes = installDbFakes(mock, env.root, ['mongodump', 'mongorestore'])

const server = {
  id: 'mg1', name: 'mongo-prod', kind: 'direct', engine: 'mongodb',
  host: 'mongo.example.com', port: 27018, username: 'backup', password: "p@ss:w'rd", database: 'admin', sslmode: 'require', tunnel: null,
}
const target = { server }

// Fake Node.js driver client
let clientState
function fakeClientFactory(uri, options) {
  clientState.created.push({ uri, options })
  const dbApi = (name) => ({
    admin: () => ({
      listDatabases: async () => ({ databases: clientState.databases.map((n) => ({ name: n })) }),
      serverInfo: async () => ({ version: '8.0.4' }),
    }),
    listCollections: () => ({ toArray: async () => (clientState.collections[name] || []).map((n) => ({ name: n })) }),
    dropDatabase: async () => { clientState.dropped.push(name) },
  })
  return {
    connect: async () => { if (clientState.connectError) throw new Error(clientState.connectError) },
    db: dbApi,
    close: async () => { clientState.closed += 1 },
  }
}
driver._internals.setClientFactory(fakeClientFactory)

beforeEach(() => {
  fakes.setState({})
  clientState = { created: [], databases: ['admin', 'config', 'local', 'shop'], collections: {}, dropped: [], closed: 0 }
})

test('is registered for mongodb on direct servers', () => {
  assert.equal(getDriver('mongodb', 'direct'), driver)
})

test('listDatabases uses the Node.js driver with credentials as options', async () => {
  assert.deepEqual(await driver.listDatabases(target), ['shop'])
  const [{ uri, options }] = clientState.created
  assert.equal(uri, 'mongodb://mongo.example.com:27018/?directConnection=true&tls=true&tlsInsecure=true&authSource=admin')
  assert.deepEqual(options.auth, { username: 'backup', password: "p@ss:w'rd" })
  assert.equal(clientState.closed, 1)
})

test('the tools get the connection string from a private --config file', async () => {
  fakes.setState({ dumpBase64: buildArchive([['shop', 'orders']]).toString('base64') })
  const outFile = path.join(env.BACKUPS_DIR, 'shop.archive')
  await driver.dump(fakeJob(), target, { database: 'shop', outFile })
  const call = fakes.calls().find((c) => c.cmd === 'mongodump')
  assert.ok(call.args[0].startsWith('--config='))
  assert.deepEqual(call.args.slice(1), ['--archive', '--db=shop'])
  assert.equal(call.options.content,
    "uri: 'mongodb://backup:p%40ss%3Aw''rd@mongo.example.com:27018/?directConnection=true&tls=true&tlsInsecure=true&authSource=admin'\n")
  if (process.platform !== 'win32') assert.equal(call.options.mode, 0o600)
  assert.ok(!call.args.join(' ').includes('backup:'))
  assert.equal(fs.existsSync(call.args[0].slice('--config='.length)), false)
  assert.equal(clientState.created.length, 0) // dump needs no driver connection
})

test('restore renames and refuses non-empty targets', async () => {
  const inFile = path.join(env.BACKUPS_DIR, 'shop_01-01-2026_10_00_00.archive')
  fs.writeFileSync(inFile, buildArchive([['shop', 'orders']]))
  clientState.collections = { shop_qa: ['orders', 'system.views'] }
  await assert.rejects(driver.restore(fakeJob(), target, { database: 'shop_qa', inFile }), /Drop target database/)
  assert.equal(fakes.calls().length, 0)

  clientState.collections = { shop_qa: ['system.views'] }
  await driver.restore(fakeJob(), target, { database: 'shop_qa', inFile })
  const call = fakes.calls().find((c) => c.cmd === 'mongorestore')
  assert.deepEqual(call.args.slice(1), ['--archive', '--nsInclude=shop.*', '--nsFrom=shop.*', '--nsTo=shop_qa.*', '--stopOnError'])

  await driver.restore(fakeJob(), target, { database: 'shop_qa', inFile, dropExisting: true })
  assert.deepEqual(clientState.dropped, ['shop_qa'])
})

test('connection errors fail the operation', async () => {
  clientState.connectError = 'Server selection timed out after 10000 ms'
  await assert.rejects(driver.drop(fakeJob(), target, { database: 'x' }), /Server selection timed out/)
})

test('sslmode mapping and URI building', () => {
  const { buildUri, tlsParams } = driver._internals
  assert.deepEqual(tlsParams({ sslmode: 'disable' }), {})
  assert.deepEqual(tlsParams({ sslmode: 'verify-full' }), { tls: 'true' })
  assert.throws(() => tlsParams({ sslmode: 'verify-full', tlsServerName: 'h' }), /SSH tunnel/)
  assert.equal(buildUri({ host: '::1', port: 27017, sslmode: 'prefer' }), 'mongodb://[::1]:27017/?directConnection=true')
})

test('testConnection reports server and tool versions', async () => {
  assert.deepEqual(await driver.testConnection(target), { version: 'MongoDB 8.0.4 · mongodump version: 100.10.0' })
})

test('dumping a missing or empty database fails and leaves no archive', async () => {
  // mongodump exits 0 with an archive that has no collections
  fakes.setState({ dumpBase64: buildArchive([]).toString('base64') })
  const outFile = path.join(env.BACKUPS_DIR, 'ghost.archive')
  await assert.rejects(driver.dump(fakeJob(), target, { database: 'ghost', outFile }), /empty or does not exist/)
  assert.equal(fs.existsSync(outFile), false)
})
