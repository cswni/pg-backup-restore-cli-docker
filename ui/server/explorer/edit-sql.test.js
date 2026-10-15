const { setupTestEnv } = require('../test-helpers')
setupTestEnv()

const { test, mock, beforeEach } = require('node:test')
const assert = require('node:assert/strict')
const { BSON } = require('mongodb')
const pgWrite = require('./postgres-write')
const myWrite = require('./mysql-write')
const postgres = require('./postgres')
const mysql = require('./mysql')
const mongoDocker = require('./mongodb-docker')
const mongoEdit = require('./mongodb-edit')
const store = require('../containercreds/store')
const { installSpawnFake } = require('./test-fakes')

const { ObjectId, Int32, Binary } = BSON
const fake = installSpawnFake(mock, ['docker', 'psql'])
beforeEach(() => {
  fake.calls.length = 0
  fake.respond(() => '')
  for (const c of store.listCredentials('local')) store.deleteCredentials('local', c.key)
})

const local = { id: 'local', name: 'Local Docker', kind: 'docker', builtin: true, dockerHost: null }
const pgTable = { schema: 'sh"op', name: 'Order Lines', type: 'table' }
const pgColumns = [
  { name: 'id', castType: 'integer', primaryKey: true },
  { name: 'note', castType: 'text' },
  { name: 'doc', castType: 'jsonb' },
  { name: 'raw', castType: 'json' },
  { name: 'tags', castType: 'text[]' },
  { name: 'day', castType: 'date' },
]

test('PostgreSQL literals are E strings with quotes and backslashes escaped; NUL is refused', () => {
  assert.equal(pgWrite.literal("it's \\x"), "E'it''s \\\\x'")
  assert.throws(() => pgWrite.literal('a\0b'), (err) => err.status === 400)
})

test('PostgreSQL UPDATE casts to catalog types and matches key and original values', () => {
  const text = pgWrite.updateSql(pgTable, pgColumns, {
    key: { id: 7 },
    original: { note: "old'); DROP TABLE x; --", doc: { a: [1, 2] }, tags: ['a', null] },
    changes: { note: null, doc: { b: 'x\\y' }, tags: ['q"t', 'b\\c', null] },
  })
  assert.ok(text.startsWith("SET statement_timeout = '10s';\n"))
  assert.ok(!text.includes('READ ONLY'))
  assert.ok(text.includes('WITH changed AS (UPDATE "sh""op"."Order Lines" SET '))
  assert.ok(text.includes('"note" = NULL'))
  assert.ok(text.includes(`"doc" = E'{"b":"x\\\\\\\\y"}'::jsonb`))
  assert.ok(text.includes(`"tags" = E'{"q\\\\"t","b\\\\\\\\c",NULL}'::text[]`))
  assert.ok(text.includes(`WHERE "id" IS NOT DISTINCT FROM E'7'::integer`))
  assert.ok(text.includes(`"note" IS NOT DISTINCT FROM E'old''); DROP TABLE x; --'::text`))
  assert.ok(text.includes(`"doc"::jsonb IS NOT DISTINCT FROM E'{"a":[1,2]}'::jsonb`))
  assert.ok(text.includes(`to_jsonb("tags") IS NOT DISTINCT FROM E'["a",null]'::jsonb`))
  assert.ok(text.endsWith('RETURNING 1)\nSELECT count(*) FROM changed'))
})

test('PostgreSQL: NULL originals, json columns and DELETE', () => {
  assert.equal(pgWrite.matchSql(pgColumns[5], null), '"day" IS NULL')
  assert.equal(pgWrite.matchSql(pgColumns[3], 'text'), `"raw"::jsonb IS NOT DISTINCT FROM E'"text"'::jsonb`)
  assert.equal(pgWrite.valueSql(pgColumns[3], 5), `E'5'::json`)
  assert.throws(() => pgWrite.valueSql(pgColumns[1], { a: 1 }), /not a JSON object/)
  const text = pgWrite.deleteSql(pgTable, pgColumns, { key: { id: 1 }, original: { day: '2026-10-14' } })
  assert.ok(text.includes(`DELETE FROM "sh""op"."Order Lines" WHERE "id" IS NOT DISTINCT FROM E'1'::integer AND "day" IS NOT DISTINCT FROM E'2026-10-14'::date RETURNING 1`))
  assert.throws(() => pgWrite.deleteSql(pgTable, pgColumns, { key: { id: 1 }, original: { 'x" = 1 OR "y': 1 } }), /No column named/)
  assert.equal(pgWrite.parseCount('1\n'), 1)
  assert.equal(pgWrite.parseCount('0\n'), 0)
  assert.throws(() => pgWrite.parseCount(''), /Unexpected psql output/)
})

test('PostgreSQL Docker edits forward saved credentials with -e NAME, never on argv', async () => {
  store.saveCredentials('local', 'pg16', { engine: 'postgres', username: 'app', password: 'pg-secret!', osUser: '', host: '127.0.0.1' })
  fake.respond(() => '1\n')
  const matched = await postgres.dockerAdapter.open({ server: local, container: 'pg16' }, 'shop',
    (s) => s.updateRow(pgTable, { columns: pgColumns }, { key: { id: 1 }, original: { note: 'a' }, changes: { note: 'b' } }))
  assert.equal(matched, 1)
  const [call] = fake.calls
  assert.ok(!call.args.join(' ').includes('pg-secret!'))
  assert.equal(call.env.PGPASSWORD, 'pg-secret!')
  assert.ok(call.args.includes('PGPASSWORD'))
  assert.ok(call.args.at(-1).startsWith("SET statement_timeout = '10s';"))
})

const myColumns = [
  { name: 'id', type: 'int(11)', primaryKey: true },
  { name: 'body', type: 'text' },
  { name: 'meta', type: 'json' },
  { name: 'ratio', type: 'float' },
  { name: 'odd`name', type: 'varchar(10)' },
]
const hex = (text) => `_utf8mb4 X'${Buffer.from(text, 'utf8').toString('hex')}'`

test('MySQL literals: hex text, validated numbers, booleans, NULL and JSON text', () => {
  assert.equal(myWrite.literal("x'; DROP TABLE t; -- \\"), hex("x'; DROP TABLE t; -- \\"))
  assert.equal(myWrite.literal(null), 'NULL')
  assert.equal(myWrite.literal(true), 'TRUE')
  assert.equal(myWrite.literal(-1.5), '-1.5')
  assert.equal(myWrite.literal({ a: 1 }), hex('{"a":1}'))
})

test('MySQL UPDATE locks and counts the matched row, then updates with LIMIT 1', () => {
  const text = myWrite.updateSql('shop', { name: 'or`ders' }, myColumns, {
    key: { id: 3 }, original: { body: 'old', meta: '{"a": 1}', ratio: 0.1, 'odd`name': null }, changes: { body: 'new', 'odd`name': 'v' },
  })
  const where = `\`id\` <=> 3 AND \`body\` <=> ${hex('old')} AND \`meta\` <=> CAST(${hex('{"a": 1}')} AS JSON) AND \`odd\`\`name\` <=> NULL`
  assert.ok(text.includes('SET SESSION innodb_lock_wait_timeout = 10;'))
  assert.ok(text.includes("'SET SESSION max_statement_time = 10'"))
  assert.ok(!text.includes('READ ONLY'))
  assert.ok(text.includes(`START TRANSACTION;\nSELECT 1 FROM \`shop\`.\`or\`\`ders\` WHERE ${where} FOR UPDATE;`))
  assert.ok(text.includes(`UPDATE \`shop\`.\`or\`\`ders\` SET \`body\` = ${hex('new')}, \`odd\`\`name\` = ${hex('v')} WHERE ${where} LIMIT 1;\nCOMMIT;`))
  assert.ok(!text.includes('ratio'))
  assert.equal(myWrite.parseMatched('1\n'), 1)
  assert.equal(myWrite.parseMatched(''), 0)
})

test('MySQL DELETE reports ROW_COUNT()', () => {
  const text = myWrite.deleteSql('shop', { name: 't' }, myColumns, { key: { id: 3 }, original: {} })
  assert.ok(text.endsWith('DELETE FROM `shop`.`t` WHERE `id` <=> 3 LIMIT 1;\nSELECT ROW_COUNT();'))
  assert.equal(myWrite.parseRowCount('0\n'), 0)
  assert.throws(() => myWrite.parseRowCount('oops'), /Unexpected mysql output/)
})

test('MySQL Docker edits keep the saved password in the environment', async () => {
  store.saveCredentials('local', 'maria', { engine: 'mysql', username: 'root', password: 'my-secret!' })
  fake.respond(() => '1\n')
  const deleted = await mysql.dockerAdapter.open({ server: local, container: 'maria' }, 'shop',
    (s) => s.deleteRow({ name: 't' }, { columns: myColumns }, { key: { id: 1 }, original: {} }))
  assert.equal(deleted, 1)
  const [call] = fake.calls
  assert.ok(!call.args.join(' ').includes('my-secret!'))
  assert.equal(call.env.PGUI_DB_PASSWORD, 'my-secret!')
  assert.deepEqual(call.args.slice(1, 5), ['-e', 'PGUI_DB_USER', '-e', 'PGUI_DB_PASSWORD'])
})

test('MongoDB values: Extended JSON is read, $ keys and code are refused', () => {
  assert.ok(mongoEdit.parseValue({ $oid: '0123456789abcdef01234567' }, 'ref') instanceof ObjectId)
  assert.throws(() => mongoEdit.parseValue({ $set: { admin: true } }, 'x'), (err) => err.status === 400 && /\$ are not allowed/.test(err.message))
  assert.throws(() => mongoEdit.parseValue({ a: [{ $gt: 1 }] }, 'x'), /x\.a\[0\]\.\$gt/)
  assert.throws(() => mongoEdit.parseValue({ $code: 'function () {}' }, 'x'), /JavaScript code/)
  assert.throws(() => mongoEdit.checkValues({ key: { _id: 1 }, original: {}, changes: { f: { $where: '1' } } }), (err) => err.status === 400)
})

function memoryStore(docs) {
  const calls = []
  return {
    calls,
    find: async (object, filter, limit) => { calls.push({ op: 'find', filter, limit }); return docs },
    updateOne: async (object, filter, update) => { calls.push({ op: 'update', filter, update }); return { matchedCount: 1 } },
    deleteOne: async (object, filter) => { calls.push({ op: 'delete', filter }); return { deletedCount: 1 } },
  }
}

test('MongoDB update resolves the displayed _id and filters on the raw values just read', async () => {
  const id = new ObjectId('0123456789abcdef01234567')
  const doc = { _id: id, qty: new Int32(2), when: new Date(0), blob: new Binary(Buffer.from([1])) }
  const s = memoryStore([doc])
  const n = await mongoEdit.updateRow(s, { name: 'c' }, {
    key: { _id: '0123456789abcdef01234567' }, original: { qty: 2, when: '1970-01-01T00:00:00.000Z', gone: null }, changes: { qty: 3, note: 'x' },
  })
  assert.equal(n, 1)
  const [find, update] = s.calls
  assert.deepEqual(find.filter._id.$in.map(String), ['0123456789abcdef01234567', '0123456789abcdef01234567'])
  assert.ok(find.filter._id.$in[1] instanceof ObjectId)
  assert.equal(update.filter._id, id)
  assert.equal(update.filter.qty.$eq, doc.qty)
  assert.equal(update.filter.when.$eq, doc.when)
  assert.deepEqual(update.filter.gone, { $eq: null })
  assert.equal(update.update.$set.qty.value, 3)
  assert.equal(update.update.$set.note, 'x')
})

test('MongoDB: a changed original or a missing document matches nothing', async () => {
  const doc = { _id: new Int32(5), qty: new Int32(2) }
  const changed = memoryStore([doc])
  assert.equal(await mongoEdit.updateRow(changed, { name: 'c' }, { key: { _id: 5 }, original: { qty: 1 }, changes: { qty: 3 } }), 0)
  assert.equal(changed.calls.length, 1)
  assert.equal(await mongoEdit.deleteRow(memoryStore([]), { name: 'c' }, { key: { _id: 5 }, original: {} }), 0)
  const ok = memoryStore([doc])
  assert.equal(await mongoEdit.deleteRow(ok, { name: 'c' }, { key: { _id: 5 }, original: { qty: 2 } }), 1)
  assert.equal(ok.calls[1].op, 'delete')
})

test('MongoDB Docker: write requests travel in PGUI_ACTION as Extended JSON, not in the program', async () => {
  store.saveCredentials('local', 'mongo7', { engine: 'mongodb', username: 'root', password: 'mg-secret!', authSource: 'admin' })
  const id = new ObjectId('0123456789abcdef01234567')
  const shellOut = (result) => `${BSON.EJSON.stringify({ result }, { relaxed: false })}\n`
  fake.respond((call) => (JSON.parse(call.args.at(-2)).op === 'rows' ? shellOut([{ _id: id, name: 'a' }]) : shellOut({ matchedCount: 1 })))
  const evil = '"); db.dropDatabase(); ("'
  const n = await mongoDocker.adapter.open({ server: local, container: 'mongo7' }, 'shop',
    (s) => s.updateRow({ name: 'users', type: 'collection' }, { columns: [] }, { key: { _id: id.toHexString() }, original: { name: 'a' }, changes: { name: evil } }))
  assert.equal(n, 1)
  const update = fake.calls[1]
  assert.equal(update.args[update.args.indexOf('shell') + 1], mongoDocker.EXPLORER_JS)
  assert.ok(!mongoDocker.EXPLORER_JS.includes('dropDatabase'))
  const action = JSON.parse(update.args.at(-2))
  assert.equal(action.op, 'update')
  assert.deepEqual(BSON.EJSON.parse(action.update), { $set: { name: evil } })
  assert.ok(BSON.EJSON.parse(action.filter, { relaxed: false })._id instanceof ObjectId)
  assert.ok(!update.args.join(' ').includes('mg-secret!'))
  assert.equal(update.env.PGUI_DB_PASSWORD, 'mg-secret!')
})
