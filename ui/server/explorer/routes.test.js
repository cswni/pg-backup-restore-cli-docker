const { setupTestEnv, startTestServer } = require('../test-helpers')
setupTestEnv()

const { test, before, after, beforeEach } = require('node:test')
const assert = require('node:assert/strict')
const { registerAdapter } = require('./adapters')

// Fake adapters: one with the SQL console, one without (like MongoDB)
let state
const calls = []
function fakeAdapter(supportsQuery) {
  return {
    supportsQuery,
    async open(target, database, fn) {
      calls.push({ op: 'open', target, database })
      if (state.connectError) throw new Error(state.connectError)
      return fn({
        objects: async () => state.objects,
        structure: async (object) => { calls.push({ op: 'structure', object }); return state.structure },
        rows: async (object, opts) => { calls.push({ op: 'rows', object, opts }); return { columns: ['id'], rows: state.rows.slice(0, opts.limit + 1) } },
        query: async (sql, limit) => { calls.push({ op: 'query', sql, limit }); return { columns: ['n'], rows: state.rows.slice(0, limit + 1) } },
      })
    },
  }
}
registerAdapter('fakesql', 'docker', fakeAdapter(true))
registerAdapter('fakedoc', 'docker', fakeAdapter(false))

let srv
const USER_PASSWORD = 'user-password-123'
const asUser = { noAuth: true, headers: { authorization: 'Basic ' + Buffer.from(`viewer:${USER_PASSWORD}`).toString('base64') } }
const base = 'serverId=local&engine=fakesql&container=db1&database=shop'

before(async () => {
  srv = await startTestServer()
  const res = await srv.request('POST', '/api/users', { body: { username: 'viewer', password: USER_PASSWORD, role: 'user' } })
  assert.equal(res.status, 201, res.text)
})
after(() => srv.close())
beforeEach(() => {
  calls.length = 0
  state = {
    objects: [
      { schema: 'public', name: 'users', type: 'table', rows: 3, sizeBytes: 8192 },
      { schema: 'audit', name: 'users', type: 'table', rows: 1, sizeBytes: 8192 },
      { schema: 'public', name: 'orders', type: 'table', rows: 120, sizeBytes: 65536 },
    ],
    structure: { columns: [{ name: 'id', type: 'integer', nullable: false, default: null, primaryKey: true }], indexes: [] },
    rows: Array.from({ length: 120 }, (_, i) => [i]),
  }
})

const get = (p, opts) => srv.request('GET', p, opts)

test('objects are listed for every signed-in role', async () => {
  const res = await get(`/api/explorer/objects?${base}`, asUser)
  assert.equal(res.status, 200, res.text)
  assert.equal(res.json.objects.length, 3)
  assert.deepEqual(calls[0], { op: 'open', target: { server: calls[0].target.server, container: 'db1' }, database: 'shop' })
})

test('target validation answers 400', async () => {
  const cases = [
    'serverId=local&engine=fakesql&database=shop',
    'serverId=local&engine=fakesql&container=--help&database=shop',
    'serverId=local&engine=fakesql&container=db1',
    'serverId=local&engine=fakesql&container=db1&database=bad%20name',
    'serverId=local&engine=nosuch&container=db1&database=shop',
    'serverId=local&engine=mongodb&container=db1&database=a$b',
  ]
  for (const q of cases) {
    const res = await get(`/api/explorer/objects?${q}`)
    assert.equal(res.status, 400, `${q}: ${res.text}`)
    assert.ok(res.json.error)
  }
  assert.equal(calls.length, 0)
  assert.equal((await get('/api/explorer/objects?serverId=nope&engine=fakesql&container=db1&database=shop')).status, 404)
})

test('structure needs an object from the catalog; 404 otherwise', async () => {
  const ok = await get(`/api/explorer/structure?${base}&schema=public&name=orders`, asUser)
  assert.equal(ok.status, 200, ok.text)
  assert.deepEqual(ok.json, {
    columns: [{ ...state.structure.columns[0], editable: false }],
    indexes: [],
    editable: true,
    editableReason: null,
    primaryKey: ['id'],
  })
  assert.deepEqual(calls.find((c) => c.op === 'structure').object, state.objects[2])

  const missing = await get(`/api/explorer/structure?${base}&schema=public&name=${encodeURIComponent('orders"; DROP TABLE x')}`)
  assert.equal(missing.status, 404)
  assert.ok(!calls.some((c) => c.op === 'structure' && c.object.name !== 'orders'))

  const ambiguous = await get(`/api/explorer/structure?${base}&name=users`)
  assert.equal(ambiguous.status, 400)
  assert.equal((await get(`/api/explorer/structure?${base}`)).status, 400)
})

test('rows: paging, hasMore and total', async () => {
  const first = await get(`/api/explorer/rows?${base}&schema=public&name=orders`, asUser)
  assert.equal(first.status, 200, first.text)
  assert.equal(first.json.rows.length, 50)
  assert.deepEqual({ ...first.json, rows: undefined }, { columns: ['id'], offset: 0, limit: 50, hasMore: true, total: null, rows: undefined })

  state.rows = state.rows.slice(100)
  const last = await get(`/api/explorer/rows?${base}&schema=public&name=orders&limit=50&offset=100`)
  assert.equal(last.json.hasMore, false)
  assert.equal(last.json.total, 120)

  state.rows = []
  const past = await get(`/api/explorer/rows?${base}&schema=public&name=orders&offset=500`)
  assert.equal(past.json.total, null)
})

test('rows: limit, offset, dir, sort and filter are validated', async () => {
  for (const q of ['limit=0', 'limit=201', 'limit=abc', 'offset=-1', 'offset=1.5', 'dir=up', 'sort=nosuch', 'filter=%7B%7D']) {
    const res = await get(`/api/explorer/rows?${base}&schema=public&name=orders&${q}`)
    assert.equal(res.status, 400, `${q}: ${res.text}`)
  }
  const sorted = await get(`/api/explorer/rows?${base}&schema=public&name=orders&sort=id&dir=desc&limit=200`)
  assert.equal(sorted.status, 200, sorted.text)
  const rowsCall = calls.find((c) => c.op === 'rows')
  assert.equal(rowsCall.opts.sort, 'id')
  assert.equal(rowsCall.opts.dir, 'desc')
  assert.equal(rowsCall.opts.limit, 200)
  assert.deepEqual(rowsCall.opts.structure, state.structure)
})

test('rows: MongoDB filters are parsed before connecting', async () => {
  // engine=mongodb on Docker uses the real adapter, which is never reached
  const bad = await get('/api/explorer/rows?serverId=local&engine=mongodb&container=m1&database=shop&name=c&filter=' + encodeURIComponent('{"$where": "1"}'))
  assert.equal(bad.status, 400)
  assert.match(bad.json.error, /\$where/)
})

test('database or tool failures answer 502 with the message', async () => {
  state.connectError = 'psql: error: connection to server failed: FATAL: password authentication failed'
  const res = await get(`/api/explorer/objects?${base}`)
  assert.equal(res.status, 502)
  assert.match(res.json.error, /password authentication failed/)
})

const query = (body, opts = {}) => srv.request('POST', '/api/explorer/query', { ...opts, body: { serverId: 'local', engine: 'fakesql', container: 'db1', database: 'shop', ...body } })

test('the SQL console is admin-only', async () => {
  const res = await query({ sql: 'SELECT 1' }, asUser)
  assert.equal(res.status, 403)
  assert.equal(calls.length, 0)
})

test('the SQL console returns rows, truncation and timing', async () => {
  const res = await query({ sql: 'SELECT n FROM t;', limit: 100 })
  assert.equal(res.status, 200, res.text)
  assert.equal(res.json.rows.length, 100)
  assert.equal(res.json.truncated, true)
  assert.equal(typeof res.json.durationMs, 'number')
  assert.deepEqual(calls.find((c) => c.op === 'query'), { op: 'query', sql: 'SELECT n FROM t', limit: 100 })

  state.rows = [[1]]
  const small = await query({ sql: 'SELECT 1' })
  assert.equal(small.json.truncated, false)
  assert.equal(calls.filter((c) => c.op === 'query')[1].limit, 200)
})

test('the SQL console validates input', async () => {
  for (const body of [{ sql: '' }, { sql: 'SELECT 1; DELETE FROM t' }, { sql: 'SELECT 1', limit: 501 }, { sql: 'SELECT 1', limit: 0 }]) {
    const res = await query(body)
    assert.equal(res.status, 400, `${JSON.stringify(body)}: ${res.text}`)
  }
  assert.equal((await query({ engine: 'postgres', sql: '\\! id' })).status, 400)
  assert.equal((await query({ engine: 'mysql', sql: 'system id' })).status, 400)
  const noConsole = await query({ engine: 'fakedoc', sql: 'SELECT 1' })
  assert.equal(noConsole.status, 400)
  assert.match(noConsole.json.error, /PostgreSQL and MySQL only/)
  assert.equal(calls.length, 0)
})
