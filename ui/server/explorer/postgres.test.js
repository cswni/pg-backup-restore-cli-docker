const { setupTestEnv } = require('../test-helpers')
setupTestEnv()

const { test, mock, beforeEach } = require('node:test')
const assert = require('node:assert/strict')
const sql = require('./postgres-sql')
const { dockerAdapter, directAdapter, createSession } = require('./postgres')
const { installSpawnFake } = require('./test-fakes')

const fake = installSpawnFake(mock, ['docker', 'psql'])
beforeEach(() => { fake.calls.length = 0; fake.respond(() => '') })

const orders = { schema: 'shop', name: 'Order "Lines"', type: 'table' }
const columns = [
  { name: 'id', type: 'integer', nullable: false, default: null, primaryKey: true },
  { name: 'note', type: 'text', nullable: true, default: null, primaryKey: false },
  { name: 'blob', type: 'bytea', nullable: true, default: null, primaryKey: false },
]

test('every statement runs read-only with a 10 s statement timeout', () => {
  assert.equal(sql.readOnly('SELECT 1'), "BEGIN READ ONLY;\nSET LOCAL statement_timeout = '10s';\nSELECT 1")
})

test('objects query skips system schemas and maps relkinds', () => {
  assert.match(sql.OBJECTS_SQL, /NOT IN \('pg_catalog', 'information_schema'\)/)
  assert.ok(sql.OBJECTS_SQL.includes("NOT LIKE 'pg\\_toast%'"))
  const out = '["public", "users", "r", 120, 16384]\n["public", "v_users", "v", null, null]\n["shop", "fresh", "r", null, 8192]\n'
  assert.deepEqual(sql.parseObjects(out), [
    { schema: 'public', name: 'users', type: 'table', rows: 120, sizeBytes: 16384 },
    { schema: 'public', name: 'v_users', type: 'view', rows: null, sizeBytes: null },
    { schema: 'shop', name: 'fresh', type: 'table', rows: null, sizeBytes: 8192 },
  ])
})

test('structure query quotes catalog names as a regclass literal', () => {
  const text = sql.structureSql({ schema: "it's", name: 'Order "Lines"' })
  assert.ok(text.includes(`'"it''s"."Order ""Lines"""'::regclass`))
  const out = JSON.stringify({
    columns: [['id', 'integer', false, "nextval('s'::regclass)", true], ['note', 'text', true, null, false]],
    indexes: [['orders_pkey', true, ['id']], ['orders_lower', false, ['lower(note)']]],
  })
  assert.deepEqual(sql.parseStructure(`${out}\n`), {
    columns: [
      { name: 'id', type: 'integer', nullable: false, default: "nextval('s'::regclass)", primaryKey: true },
      { name: 'note', type: 'text', nullable: true, default: null, primaryKey: false },
    ],
    indexes: [{ name: 'orders_pkey', columns: ['id'], unique: true }, { name: 'orders_lower', columns: ['lower(note)'], unique: false }],
  })
})

test('rows query quotes names, sorts by the primary key by default and fetches one extra row', () => {
  const text = sql.rowsSql(orders, columns, { limit: 50, offset: 100 })
  assert.ok(text.includes('FROM "shop"."Order ""Lines"""'))
  assert.ok(text.endsWith('ORDER BY "id" ASC LIMIT 51 OFFSET 100'))
  assert.ok(text.includes(`encode(substring("blob" FROM 1 FOR 32), 'hex')`))
  assert.ok(text.includes('left("note"::text, 2000)'))
  const sorted = sql.rowsSql(orders, columns, { limit: 10, offset: 0, sort: 'note', dir: 'desc' })
  assert.ok(sorted.endsWith('ORDER BY "note" DESC LIMIT 11 OFFSET 0'))
})

test('row output becomes cells', () => {
  const out = '[1, 1, 3, "abc", 40, "00ff"]\n[2, 2, 9000, "' + 'x'.repeat(2000) + '", null, null]\n'
  assert.deepEqual(sql.parseRows(out, columns), {
    columns: ['id', 'note', 'blob'],
    rows: [
      [1, 'abc', { binary: true, length: 40, preview: '00ff' }],
      [2, { truncated: true, value: 'x'.repeat(2000), length: 9000 }, null],
    ],
  })
})

test('console wraps the statement as a subquery and keeps column order and duplicates', () => {
  const text = sql.consoleSql('SELECT 1 AS a -- trailing comment', 200)
  assert.ok(text.includes('FROM (\nSELECT 1 AS a -- trailing comment\n) AS pgui_explorer_row LIMIT 201'))
  const out = '[["a", 1], ["a", "x"]]\n[["a", 2], ["a", null]]\n'
  assert.deepEqual(sql.parseConsole(out), { columns: ['a', 'a'], rows: [[1, 'x'], [2, null]] })
  assert.deepEqual(sql.parseConsole(''), { columns: [], rows: [] })
  assert.deepEqual(sql.parseHeader('id\0name\n'), ['id', 'name'])
})

test('session asks psql for the header when a console query returns no rows', async () => {
  const seen = []
  const session = createSession(async (args) => {
    seen.push(args)
    return args.includes('-z') ? 'id\0name\n' : ''
  }, 'shop')
  assert.deepEqual(await session.query('SELECT id, name FROM t WHERE false', 10), { columns: ['id', 'name'], rows: [] })
  assert.equal(seen.length, 2)
  assert.ok(seen[1].at(-1).includes('LIMIT 0'))
})

test('Docker targets run psql in the container as the postgres user', async () => {
  fake.respond(() => '["public", "users", "r", 1, 2]\n')
  const target = { server: { id: 'local', name: 'Local Docker', kind: 'docker', builtin: true, dockerHost: null }, container: 'pg16' }
  const objects = await dockerAdapter.open(target, 'shop', (s) => s.objects())
  assert.equal(objects[0].name, 'users')
  const [call] = fake.calls
  assert.equal(call.cmd, 'docker')
  assert.deepEqual(call.args.slice(0, 7), ['exec', '-u', 'postgres', '-e', 'PGCLIENTENCODING=UTF8', 'pg16', 'psql'])
  assert.deepEqual(call.args.slice(-4, -1), ['-d', 'shop', '-c'])
  assert.ok(call.args.at(-1).startsWith('BEGIN READ ONLY;'))
})

test('direct targets pass the password in PGPASSWORD, never on argv', async () => {
  fake.respond(() => '')
  const server = { id: 'pg1', name: 'prod', kind: 'direct', engine: 'postgres', host: 'db.example.com', port: 5432, username: 'reader', password: 's3cret!', sslmode: 'require', tunnel: null }
  await directAdapter.open({ server }, 'shop', (s) => s.objects())
  const [call] = fake.calls
  assert.equal(call.cmd, 'psql')
  assert.equal(call.env.PGPASSWORD, 's3cret!')
  assert.equal(call.env.PGHOST, 'db.example.com')
  assert.equal(call.env.PGCLIENTENCODING, 'UTF8')
  assert.equal(call.env.APP_SECRET, undefined)
  assert.ok(!call.args.join(' ').includes('s3cret!'))
})

test('psql failures reject with the tool message', async () => {
  fake.respond(() => ({ stderr: 'ERROR:  permission denied for table users\n', code: 1 }))
  const server = { id: 'pg1', name: 'prod', kind: 'direct', engine: 'postgres', host: 'h', port: 5432, username: 'u', password: '', sslmode: 'prefer', tunnel: null }
  await assert.rejects(directAdapter.open({ server }, 'shop', (s) => s.objects()), /permission denied/)
})
