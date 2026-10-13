const path = require('path')
const { setupTestEnv } = require('../test-helpers')
const env = setupTestEnv()

const { test, mock, beforeEach } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const childProcess = require('child_process')
const { installDbFakes, fakeJob } = require('./fake-db-tools')
const driver = require('./mysql-docker')
const { getDriver, listEngines } = require('./index')
const { detectEngine } = require('../docker')
const { LOCAL_SERVER } = require('../servers')

const fakes = installDbFakes(mock, env.root, ['docker'])
const target = { server: LOCAL_SERVER, container: 'shop-db' }

function writeDump(content) {
  const file = path.join(env.BACKUPS_DIR, `shop_${Date.now()}.sql`)
  fs.writeFileSync(file, content)
  return file
}

beforeEach(() => fakes.setState({}))

test('is registered for mysql on docker servers and detects MySQL images', () => {
  assert.equal(getDriver('mysql', 'docker'), driver)
  for (const image of ['mysql:8.4', 'mariadb:11', 'percona/percona-server:8.0', 'bitnami/mariadb']) {
    assert.equal(detectEngine(image), 'mysql', image)
  }
  assert.equal(detectEngine('postgres:18'), 'postgres')
})

test('listEngines exposes capabilities per server kind', () => {
  const mysql = listEngines().find((e) => e.engine === 'mysql')
  assert.equal(mysql.fileExtension, '.sql')
  assert.deepEqual(mysql.operations.docker, ['export', 'restore', 'create', 'delete', 'unblock'])
  const mongo = listEngines().find((e) => e.engine === 'mongodb')
  assert.deepEqual(mongo.operations.docker, ['export', 'restore', 'delete'])
  assert.deepEqual(mongo.kinds.sort(), ['direct', 'docker'])
})

test('listDatabases runs the client via docker exec and hides system schemas', async () => {
  fakes.setState({ existing: ['shop', 'shop_qa'] })
  assert.deepEqual(await driver.listDatabases(target), ['shop', 'shop_qa'])
  const [call] = fakes.calls()
  assert.equal(call.via.container, 'shop-db')
  assert.equal(call.sql, 'SHOW DATABASES;')
})

test('database names reach the container as positional arguments only', () => {
  const args = driver._internals.execArgs(target, 'dump', ['--single-transaction', 'shop'], false)
  assert.deepEqual(args.slice(0, 5), ['exec', 'shop-db', 'sh', '-c', driver._internals.MYSQL_SH])
  assert.deepEqual(args.slice(5), ['sh', 'dump', '--single-transaction', 'shop'])
  assert.ok(!driver._internals.MYSQL_SH.includes('shop'))
})

test('dump streams mysqldump output (single database, no --databases) to the file', async () => {
  fakes.setState({ dump: '-- dump\nCREATE TABLE t (id int);\n' })
  const outFile = path.join(env.BACKUPS_DIR, 'shop.sql')
  await driver.dump(fakeJob(), target, { database: 'shop', outFile })
  assert.equal(fs.readFileSync(outFile, 'utf8'), '-- dump\nCREATE TABLE t (id int);\n')
  const call = fakes.calls().find((c) => c.cmd === 'mariadb-dump')
  assert.equal(call.args.at(-1), 'shop')
  assert.ok(call.args.includes('--single-transaction') && call.args.includes('--routines'))
  assert.ok(!call.args.includes('--databases'))
})

test('a failed dump removes the partial file', async () => {
  fakes.setState({ dump: 'partial', dumpExit: 2, dumpStderr: 'mysqldump: Got error: 1045: Access denied\n' })
  const outFile = path.join(env.BACKUPS_DIR, 'failed.sql')
  const job = fakeJob()
  await assert.rejects(driver.dump(job, target, { database: 'shop', outFile }), /mysqldump exited with code 2/)
  assert.equal(fs.existsSync(outFile), false)
  assert.ok(job.lines.some((l) => l.stream === 'stderr' && l.text.includes('Access denied')))
})

test('restore creates a missing target and strips CREATE DATABASE / USE', async () => {
  fakes.setState({ existing: ['shop'] })
  const dump = [
    '/*M!999999\\- enable the sandbox mode */',
    'CREATE DATABASE /*!32312 IF NOT EXISTS*/ `shop` /*!40100 DEFAULT CHARACTER SET utf8mb4 */;',
    'USE `shop`;',
    'CREATE TABLE t (id int);',
    "INSERT INTO t VALUES (1),(2),('USE `x`;');",
    '',
  ].join('\n')
  const job = fakeJob()
  await driver.restore(job, target, { database: 'shop_qa', inFile: writeDump(dump), dropExisting: false })
  const sql = fakes.calls().filter((c) => c.sql).map((c) => c.sql)
  assert.ok(sql.includes('CREATE DATABASE `shop_qa`;'))
  const restore = fakes.calls().find((c) => c.stdin !== undefined)
  assert.equal(restore.interactive, true)
  assert.equal(restore.args.at(-1), 'shop_qa')
  assert.equal(restore.stdin, "CREATE TABLE t (id int);\nINSERT INTO t VALUES (1),(2),('USE `x`;');\n")
  assert.ok(job.lines.some((l) => l.text.includes('Restore completed without errors')))
})

test('restore refuses a dump with several databases', async () => {
  fakes.setState({ existing: [] })
  const dump = 'USE `a`;\nCREATE TABLE t (id int);\nUSE `b`;\n'
  await assert.rejects(driver.restore(fakeJob(), target, { database: 'x', inFile: writeDump(dump) }), /several databases \(a, b\)/)
})

test('restore refuses an existing database that has tables', async () => {
  fakes.setState({ existing: ['shop'], tables: { shop: 4 } })
  const job = fakeJob()
  await assert.rejects(driver.restore(job, target, { database: 'shop', inFile: writeDump('SELECT 1;\n') }), /Drop target database/)
  assert.ok(job.lines.some((l) => l.text.includes('contains 4 table(s)')))
  assert.equal(fakes.calls().some((c) => c.stdin !== undefined), false)
})

test('restore into an existing empty database proceeds', async () => {
  fakes.setState({ existing: ['shop'], tables: { shop: 0 } })
  await driver.restore(fakeJob(), target, { database: 'shop', inFile: writeDump('SELECT 1;\n') })
  assert.equal(fakes.calls().some((c) => c.sql?.startsWith('CREATE DATABASE')), false)
  assert.ok(fakes.calls().some((c) => c.stdin !== undefined))
})

test('dropExisting drops the target first', async () => {
  fakes.setState({ existing: [] })
  await driver.restore(fakeJob(), target, { database: 'shop', inFile: writeDump('SELECT 1;\n'), dropExisting: true })
  assert.equal(fakes.calls()[0].sql, 'DROP DATABASE IF EXISTS `shop`;')
})

test('restore fails when mysql exits non-zero', async () => {
  fakes.setState({ restoreStderr: 'ERROR 1064 (42000) at line 3: You have an error in your SQL syntax\n', restoreExit: 1 })
  const job = fakeJob()
  await assert.rejects(driver.restore(job, target, { database: 'shop', inFile: writeDump('bad;\n') }), /mysql exited with code 1/)
  assert.ok(job.lines.some((l) => l.stream === 'stderr' && l.text.startsWith('ERROR 1064')))
})

test('restore fails on ERROR output even when mysql exits 0', async () => {
  fakes.setState({ restoreStderr: 'ERROR 1146 (42S02) at line 9: Table missing\n' })
  await assert.rejects(driver.restore(fakeJob(), target, { database: 'shop', inFile: writeDump('x;\n') }), /1 error/)
})

test('create, drop and unblock run the expected SQL', async () => {
  fakes.setState({ processlist: [11, 12], goneThreads: [12] })
  await driver.create(fakeJob(), target, { database: 'new_db' })
  await driver.drop(fakeJob(), target, { database: 'old_db' })
  const job = fakeJob()
  await driver.unblock(job, target, { database: 'busy' })
  const sql = fakes.calls().map((c) => c.sql)
  assert.deepEqual(sql.slice(0, 2), ['CREATE DATABASE `new_db`;', 'DROP DATABASE `old_db`;'])
  assert.match(sql[2], /PROCESSLIST WHERE DB = 'busy' AND ID <> CONNECTION_ID\(\)/)
  assert.deepEqual(sql.slice(3), ['KILL 11;', 'KILL 12;'])
  assert.ok(job.lines.some((l) => l.text.includes('2 connection(s) terminated')))
})

test('SQL failures surface the client error', async () => {
  fakes.setState({ failSql: 'CREATE DATABASE' })
  await assert.rejects(driver.create(fakeJob(), target, { database: 'x' }), /CREATE DATABASE failed/)
})

// Runs the real in-container shell snippet with a fake mariadb-dump (needs sh).
const hasSh = childProcess.spawnSync('sh', ['-c', 'command -v mktemp sed >/dev/null && echo ok']).stdout?.toString().trim() === 'ok'

test('the container snippet reads the root password from the environment into an option file', { skip: !hasSh && 'sh not available' }, () => {
  const bin = fs.mkdtempSync(path.join(env.root, 'bin-'))
  fs.writeFileSync(path.join(bin, 'mariadb-dump'), '#!/bin/sh\nf=${1#--defaults-extra-file=}\ncat "$f"\nshift\necho "ARGS:$*"\n', { mode: 0o755 })
  // The script goes in on stdin (Windows argv quoting would mangle its
  // backslashes); cwd + $PWD keeps the path in sh's own format.
  const res = childProcess.spawnSync('sh', ['-s', 'dump', '--single-transaction', 'shop'], {
    input: `PATH="$PWD:$PATH"\n${driver._internals.MYSQL_SH}\n`,
    cwd: bin,
    env: { ...process.env, MARIADB_ROOT_PASSWORD: 'p"a\\ss', MYSQL_ROOT_PASSWORD: '' },
  })
  const out = res.stdout.toString()
  assert.equal(res.status, 0, res.stderr.toString())
  assert.match(out, /\[client\]\nuser=root\npassword="p\\"a\\\\ss"\n/)
  assert.match(out, /ARGS:--single-transaction shop/)
})
