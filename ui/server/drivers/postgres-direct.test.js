const path = require('path')
const { setupTestEnv } = require('../test-helpers')
const env = setupTestEnv({ SCRIPTS_DIR: path.join(__dirname, '..', '..', '..', 'scripts') })

const { test, mock, beforeEach } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const { installFakes } = require('../connectivity/fake-tools')
const driver = require('./postgres-direct')
const { getDriver } = require('./index')

const fakes = installFakes(mock, env.root, ['psql', 'pg_dump'])

const server = {
  id: 'abc123', name: 'prod-db', kind: 'direct', engine: 'postgres',
  host: 'db.example.com', port: 5433, username: 'backup', password: 's3cret!', database: 'postgres', sslmode: 'require', tunnel: null,
}
const target = { server }

function fakeJob() {
  const lines = []
  return { lines, log: (text, stream = 'stdout') => lines.push({ text: String(text), stream }) }
}

const DUMP = [
  'SET statement_timeout = 0;',
  'CREATE DATABASE premas WITH TEMPLATE = template0 ENCODING = \'UTF8\';',
  'ALTER DATABASE premas OWNER TO postgres;',
  '\\connect premas',
  'ALTER DATABASE premas SET search_path TO public;',
  'COMMENT ON DATABASE premas IS \'main\';',
  'CREATE TABLE t (id int);',
  '',
].join('\n')

function writeDump() {
  const file = path.join(env.BACKUPS_DIR, 'premas_01-01-2026_10_00_00.sql')
  fs.writeFileSync(file, DUMP)
  return file
}

beforeEach(() => fakes.setState({}))

test('is registered for postgres on direct servers', () => {
  assert.equal(getDriver('postgres', 'direct'), driver)
})

test('passes credentials via the environment, never as arguments', async () => {
  fakes.setState({ existing: ['app', 'postgres'] })
  const dbs = await driver.listDatabases(target)
  assert.deepEqual(dbs, ['app', 'postgres'])
  const [call] = fakes.calls()
  assert.equal(call.env.PGPASSWORD, 's3cret!')
  assert.equal(call.env.PGHOST, 'db.example.com')
  assert.equal(call.env.PGPORT, '5433')
  assert.equal(call.env.PGUSER, 'backup')
  assert.equal(call.env.PGSSLMODE, 'require')
  assert.equal(call.env.PGCONNECT_TIMEOUT, '10')
  assert.ok(!call.args.join(' ').includes('s3cret'))
})

test('dump runs pg_dump -C and writes the output file', async () => {
  fakes.setState({ dump: DUMP })
  const outFile = path.join(env.BACKUPS_DIR, 'out.sql')
  await driver.dump(fakeJob(), target, { database: 'premas', outFile })
  assert.equal(fs.readFileSync(outFile, 'utf8'), DUMP)
  const call = fakes.calls().find((c) => c.cmd === 'pg_dump')
  assert.ok(call.args.includes('-C'))
  assert.equal(call.args.at(-1), 'premas')
})

test('a failed dump removes the partial file', async () => {
  fakes.setState({ dump: 'partial', dumpExit: 1, dumpStderr: 'pg_dump: error: connection failed\n' })
  const outFile = path.join(env.BACKUPS_DIR, 'failed.sql')
  const job = fakeJob()
  await assert.rejects(driver.dump(job, target, { database: 'premas', outFile }), /pg_dump exited with code 1/)
  assert.equal(fs.existsSync(outFile), false)
  assert.ok(job.lines.some((l) => l.stream === 'stderr' && l.text.includes('connection failed')))
})

test('a dump that cannot be written fails instead of hanging', async () => {
  fakes.setState({ dump: DUMP })
  const outFile = path.join(env.BACKUPS_DIR, 'missing-dir', 'out.sql')
  await assert.rejects(driver.dump(fakeJob(), target, { database: 'premas', outFile }), /Cannot write out\.sql/)
})

test('restore creates a missing target and retargets the dump', async () => {
  fakes.setState({ existing: ['postgres'] })
  const job = fakeJob()
  await driver.restore(job, target, { database: 'premas_qa', inFile: writeDump(), dropExisting: false })

  const sql = fakes.calls().filter((c) => c.sql).map((c) => c.sql)
  assert.ok(sql.some((s) => s === 'CREATE DATABASE "premas_qa";'))
  const restore = fakes.calls().find((c) => c.stdin !== undefined)
  assert.equal(restore.args.at(-1), 'premas_qa')
  assert.ok(!restore.stdin.includes('CREATE DATABASE'))
  assert.ok(!restore.stdin.includes('\\connect'))
  assert.ok(restore.stdin.includes('ALTER DATABASE "premas_qa" OWNER TO postgres;'))
  assert.ok(restore.stdin.includes('ALTER DATABASE "premas_qa" SET search_path TO public;'))
  assert.ok(restore.stdin.includes('COMMENT ON DATABASE "premas_qa" IS \'main\';'))
  assert.ok(restore.stdin.includes('CREATE TABLE t (id int);'))
  assert.ok(job.lines.some((l) => l.text.includes('Restore completed without errors')))
})

test('restore refuses an existing database that has tables', async () => {
  fakes.setState({ existing: ['postgres', 'premas'], tables: { premas: 3 } })
  const job = fakeJob()
  await assert.rejects(driver.restore(job, target, { database: 'premas', inFile: writeDump(), dropExisting: false }), /Drop target database/)
  assert.ok(job.lines.some((l) => l.text.includes('contains 3 table(s)')))
  assert.equal(fakes.calls().some((c) => c.stdin !== undefined), false)
})

test('restore into an existing empty database proceeds without creating it', async () => {
  fakes.setState({ existing: ['postgres', 'premas'], tables: { premas: 0 } })
  await driver.restore(fakeJob(), target, { database: 'premas', inFile: writeDump(), dropExisting: false })
  assert.equal(fakes.calls().some((c) => c.sql?.startsWith('CREATE DATABASE')), false)
  assert.ok(fakes.calls().some((c) => c.stdin !== undefined))
})

test('dropExisting drops the target WITH (FORCE) first', async () => {
  fakes.setState({ existing: ['postgres'] })
  await driver.restore(fakeJob(), target, { database: 'premas', inFile: writeDump(), dropExisting: true })
  const sql = fakes.calls().filter((c) => c.sql).map((c) => c.sql)
  assert.equal(sql[0], 'DROP DATABASE IF EXISTS "premas" WITH (FORCE);')
  assert.equal(fakes.calls().find((c) => c.sql === sql[0]).args.at(-3), 'postgres')
})

test('restore fails when psql reports SQL errors', async () => {
  fakes.setState({ existing: ['postgres'], restoreStderr: 'ERROR:  relation "t" already exists\nERROR:  oops\n' })
  const job = fakeJob()
  await assert.rejects(driver.restore(job, target, { database: 'premas', inFile: writeDump() }), /2 SQL error/)
  assert.ok(job.lines.some((l) => l.stream === 'stderr' && l.text.startsWith('ERROR:  relation')))
})

test('create, drop and unblock run the same SQL as the scripts', async () => {
  fakes.setState({})
  await driver.create(fakeJob(), target, { database: 'new_db' })
  await driver.drop(fakeJob(), target, { database: 'old_db' })
  await driver.unblock(fakeJob(), target, { database: 'busy' })
  const sql = fakes.calls().map((c) => c.sql)
  assert.deepEqual(sql.slice(0, 2), ['CREATE DATABASE "new_db";', 'DROP DATABASE "old_db" WITH (FORCE);'])
  assert.match(sql[2], /pg_terminate_backend\(pid\).*datname = 'busy'/)
})

test('SQL failures surface psql stderr', async () => {
  fakes.setState({ failSql: 'CREATE DATABASE' })
  await assert.rejects(driver.create(fakeJob(), target, { database: 'x' }), /CREATE DATABASE failed/)
})

test('testConnection reports the server version', async () => {
  fakes.setState({})
  assert.deepEqual(await driver.testConnection(target), { version: 'PostgreSQL 18.0 (fake)' })
})

test('quoting helpers escape identifiers and literals', () => {
  const { quoteIdent, quoteLiteral, pgEnv } = driver._internals
  assert.equal(quoteIdent('a"b'), '"a""b"')
  assert.equal(quoteLiteral("o'k"), "'o''k'")
  const e = pgEnv({ host: '127.0.0.1', port: 40000, username: 'u', password: '', sslmode: 'verify-full', tlsServerName: 'db.example.com' })
  assert.equal(e.PGHOST, 'db.example.com')
  assert.equal(e.PGHOSTADDR, '127.0.0.1')
  assert.equal(e.PGPASSWORD, undefined)
})
