const { setupTestEnv } = require('../test-helpers')
setupTestEnv()

const { test, mock, beforeEach } = require('node:test')
const assert = require('node:assert/strict')
const sql = require('./mysql-sql')
const { dockerAdapter, directAdapter } = require('./mysql')
const { installSpawnFake } = require('./test-fakes')

const fake = installSpawnFake(mock, ['docker', 'mariadb'])
beforeEach(() => { fake.calls.length = 0; fake.respond(() => '') })

const columns = [
  { name: 'id', type: 'int(11)', primaryKey: true },
  { name: 'body', type: 'longtext', primaryKey: false },
  { name: 'hash', type: 'varbinary(32)', primaryKey: false },
  { name: 'created', type: 'datetime(6)', primaryKey: false },
  { name: 'flags', type: 'bit(8)', primaryKey: false },
]

test('statements run in a read-only transaction with the timeout for MySQL or MariaDB', () => {
  const text = sql.readOnly('SELECT 1;')
  assert.ok(text.startsWith('SET SESSION TRANSACTION READ ONLY;'))
  assert.ok(text.includes("'SET SESSION max_statement_time = 10'"))
  assert.ok(text.includes("'SET SESSION max_execution_time = 10000'"))
  assert.ok(text.endsWith('START TRANSACTION READ ONLY;\nSELECT 1;'))
})

test('objects come from information_schema.TABLES', () => {
  assert.ok(sql.objectsSql("o'k").includes("TABLE_SCHEMA = 'o''k'"))
  const out = '["orders", "BASE TABLE", 12, 32768]\n["v_orders", "VIEW", null, null]\n'
  assert.deepEqual(sql.parseObjects(out), [
    { schema: null, name: 'orders', type: 'table', rows: 12, sizeBytes: 32768 },
    { schema: null, name: 'v_orders', type: 'view', rows: null, sizeBytes: null },
  ])
})

test('structure groups index columns and reads booleans', () => {
  const text = sql.structureSql('shop', { name: 'it\'s' })
  assert.ok(text.includes("TABLE_NAME = 'it''s'"))
  const out = [
    '["c", "id", "int(11)", 0, null, 1]',
    '["c", "email", "varchar(200)", 1, "NULL", 0]',
    '["i", "PRIMARY", 1, "id"]',
    '["i", "by_name", 0, "last"]',
    '["i", "by_name", 0, "first"]',
    '["i", "by_expr", 0, null]',
  ].join('\n')
  assert.deepEqual(sql.parseStructure(out), {
    columns: [
      { name: 'id', type: 'int(11)', nullable: false, default: null, primaryKey: true },
      { name: 'email', type: 'varchar(200)', nullable: true, default: 'NULL', primaryKey: false },
    ],
    indexes: [
      { name: 'PRIMARY', columns: ['id'], unique: true },
      { name: 'by_name', columns: ['last', 'first'], unique: false },
      { name: 'by_expr', columns: ['(expression)'], unique: false },
    ],
  })
})

test('column kinds come from COLUMN_TYPE', () => {
  assert.deepEqual(columns.map(sql.columnKind), ['plain', 'text', 'binary', 'datetime', 'plain'])
  assert.equal(sql.columnKind({ type: 'int unsigned' }), 'plain')
  assert.equal(sql.columnKind({ type: 'json' }), 'text')
  assert.equal(sql.columnKind({ type: "enum('a','b')" }), 'text')
})

test('rows query quotes names and builds slots per kind', () => {
  const text = sql.rowsSql('shop', { name: 'odd`name' }, columns, { limit: 20, offset: 40, sort: 'created', dir: 'desc' })
  assert.ok(text.includes('FROM `shop`.`odd``name`'))
  assert.ok(text.includes('CHAR_LENGTH(`body`), LEFT(`body`, 2000)'))
  assert.ok(text.includes('LENGTH(`hash`), HEX(LEFT(`hash`, 32))'))
  assert.ok(text.includes('NULL, `flags` + 0'))
  assert.ok(text.endsWith('ORDER BY `created` DESC LIMIT 21 OFFSET 40;'))
  assert.ok(sql.rowsSql('shop', { name: 't' }, columns, { limit: 1, offset: 0 }).includes('ORDER BY `id` ASC'))
})

test('row output becomes cells', () => {
  const out = `[null, 7, 5000, "${'b'.repeat(2000)}", 4, "DEADBEEF", null, "2026-10-14 08:30:00.000000", null, 3]\n`
  assert.deepEqual(sql.parseRows(out, columns).rows, [[
    7,
    { truncated: true, value: 'b'.repeat(2000), length: 5000 },
    { binary: true, length: 4, preview: 'deadbeef' },
    '2026-10-14T08:30:00.000000',
    3,
  ]])
})

test('console text travels as hex through PREPARE, with a row cap', () => {
  const text = sql.consoleSql("SELECT 'a\\'b' -- \\! ls", 500)
  assert.ok(text.startsWith('SET SESSION sql_select_limit = 501;'))
  const hex = text.match(/X'([0-9a-f]+)'/)[1]
  assert.equal(Buffer.from(hex, 'hex').toString('utf8'), "SELECT 'a\\'b' -- \\! ls")
  assert.ok(!text.includes('\\!'))
  assert.ok(text.endsWith('PREPARE pgui_stmt FROM @pgui_sql;\nEXECUTE pgui_stmt;'))
})

test('batch output is unescaped; NULL becomes null', () => {
  assert.equal(sql.batchField('a\\tb\\nc\\\\d\\0'), 'a\tb\nc\\d\0')
  assert.equal(sql.batchField('NULL'), null)
  assert.deepEqual(sql.parseBatch('id\tnote\n1\tline1\\nline2\n2\tNULL\n'), {
    columns: ['id', 'note'],
    rows: [['1', 'line1\nline2'], ['2', null]],
  })
  assert.deepEqual(sql.parseBatch(''), { columns: [], rows: [] })
})

test('Docker targets use the driver wrapper (root password from the container environment)', async () => {
  fake.respond(() => '["orders", "BASE TABLE", 1, 2]\n')
  const target = { server: { id: 'local', name: 'Local Docker', kind: 'docker', builtin: true, dockerHost: null }, container: 'maria' }
  const objects = await dockerAdapter.open(target, 'shop', (s) => s.objects())
  assert.equal(objects[0].name, 'orders')
  const [call] = fake.calls
  assert.equal(call.cmd, 'docker')
  assert.deepEqual(call.args.slice(0, 4), ['exec', 'maria', 'sh', '-c'])
  assert.deepEqual(call.args.slice(5, 11), ['sh', 'client', '-N', '-B', '-r', '--default-character-set=utf8mb4'])
  assert.equal(call.args.at(-1), 'shop')
})

test('direct targets put credentials in an option file and run the client sandboxed', async () => {
  fake.respond((call) => (call.args.includes('-N') ? '' : 'n\n1\n'))
  const server = { id: 'my1', name: 'prod', kind: 'direct', engine: 'mysql', host: 'db.example.com', port: 3306, username: 'reader', password: 'pa"ss', sslmode: 'prefer', tunnel: null }
  const result = await directAdapter.open({ server }, 'shop', (s) => s.query('SELECT 1 AS n', 200))
  assert.deepEqual(result, { columns: ['n'], rows: [['1']] })
  const [call] = fake.calls
  assert.equal(call.cmd, 'mariadb')
  assert.ok(call.args.includes('--sandbox'))
  assert.match(call.optionFile, /password="pa\\"ss"/)
  assert.ok(!call.args.join(' ').includes('pa"ss'))
  assert.ok(call.args[call.args.indexOf('-e') + 1].includes('EXECUTE pgui_stmt;'))
})
