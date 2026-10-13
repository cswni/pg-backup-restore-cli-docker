const path = require('path')
const { setupTestEnv } = require('../test-helpers')
const env = setupTestEnv()

const { test, mock, beforeEach } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const { installDbFakes, fakeJob } = require('./fake-db-tools')
const driver = require('./mysql-direct')
const { getDriver } = require('./index')

const fakes = installDbFakes(mock, env.root, ['mariadb', 'mariadb-dump'])

const server = {
  id: 'my1', name: 'shop-prod', kind: 'direct', engine: 'mysql',
  host: 'mysql.example.com', port: 3307, username: 'backup', password: 'p"w\\d#1', database: 'mysql', sslmode: 'require', tunnel: null,
}
const target = { server }

beforeEach(() => fakes.setState({}))

test('is registered for mysql on direct servers', () => {
  assert.equal(getDriver('mysql', 'direct'), driver)
})

test('credentials go into a private option file, never on the command line', async () => {
  fakes.setState({ existing: ['shop'] })
  assert.deepEqual(await driver.listDatabases(target), ['shop'])
  const [call] = fakes.calls()
  assert.ok(call.args[0].startsWith('--defaults-extra-file='))
  assert.equal(call.options.content, '[client]\nuser="backup"\npassword="p\\"w\\\\d#1"\n')
  if (process.platform !== 'win32') assert.equal(call.options.mode, 0o600)
  assert.ok(!call.args.join(' ').includes('p"w'))
  assert.ok(call.args.includes('--host=mysql.example.com') && call.args.includes('--port=3307'))
  assert.ok(call.args.includes('--sandbox'))
  // The option file is deleted afterwards
  assert.equal(fs.existsSync(call.args[0].slice('--defaults-extra-file='.length)), false)
})

test('sslmode maps to MariaDB client TLS options', () => {
  const { sslArgs } = driver._internals
  assert.deepEqual(sslArgs({ sslmode: 'disable' }), ['--skip-ssl'])
  assert.deepEqual(sslArgs({ sslmode: 'prefer' }), ['--skip-ssl-verify-server-cert'])
  assert.deepEqual(sslArgs({ sslmode: 'require' }), ['--ssl', '--skip-ssl-verify-server-cert'])
  assert.deepEqual(sslArgs({ sslmode: 'verify-full' }), ['--ssl', '--ssl-verify-server-cert'])
  assert.throws(() => sslArgs({ sslmode: 'verify-full', tlsServerName: 'db' }), /not supported through an SSH tunnel/)
})

test('dump runs mariadb-dump for one database and fails cleanly', async () => {
  fakes.setState({ dump: 'CREATE TABLE t (id int);\n' })
  const outFile = path.join(env.BACKUPS_DIR, 'shop.sql')
  await driver.dump(fakeJob(), target, { database: 'shop', outFile })
  assert.equal(fs.readFileSync(outFile, 'utf8'), 'CREATE TABLE t (id int);\n')
  const call = fakes.calls().find((c) => c.cmd === 'mariadb-dump')
  assert.equal(call.args.at(-1), 'shop')
  assert.ok(!call.args.includes('--sandbox'))

  fakes.setState({ dump: 'part', dumpExit: 1 })
  const bad = path.join(env.BACKUPS_DIR, 'bad.sql')
  await assert.rejects(driver.dump(fakeJob(), target, { database: 'shop', outFile: bad }), /exited with code 1/)
  assert.equal(fs.existsSync(bad), false)
})

test('restore renames: dump of shop restored as shop_qa', async () => {
  fakes.setState({ existing: ['shop'] })
  const inFile = path.join(env.BACKUPS_DIR, 'shop_01-01-2026_10_00_00.sql')
  fs.writeFileSync(inFile, 'USE `shop`;\nCREATE TABLE t (id int);\n')
  await driver.restore(fakeJob(), target, { database: 'shop_qa', inFile, dropExisting: false })
  const restore = fakes.calls().find((c) => c.stdin !== undefined)
  assert.equal(restore.args.at(-1), 'shop_qa')
  assert.equal(restore.stdin, 'CREATE TABLE t (id int);\n')
})

test('testConnection reports the server version', async () => {
  assert.deepEqual(await driver.testConnection(target), { version: 'MySQL/MariaDB 8.4.2' })
})
