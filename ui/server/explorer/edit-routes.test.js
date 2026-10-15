const { setupTestEnv, startTestServer } = require('../test-helpers')
setupTestEnv()

const { test, before, after, beforeEach } = require('node:test')
const assert = require('node:assert/strict')
const { registerAdapter } = require('./adapters')

// Fake SQL adapter: catalog, structure and the rows matched by each change.
let state
const calls = []
registerAdapter('fakeedit', 'docker', {
  supportsQuery: true,
  async open(target, database, fn) {
    return fn({
      objects: async () => state.objects,
      structure: async () => state.structure,
      updateRow: async (object, structure, request) => { calls.push({ op: 'update', object, request }); return state.result() },
      deleteRow: async (object, structure, request) => { calls.push({ op: 'delete', object, request }); return state.result() },
    })
  },
})

const col = (name, extra = {}) => ({ name, type: 'text', nullable: true, default: null, primaryKey: false, editable: true, ...extra })

let srv
const asUser = { noAuth: true, headers: { authorization: 'Basic ' + Buffer.from('viewer:user-password-123').toString('base64') } }
const target = { serverId: 'local', engine: 'fakeedit', container: 'db1', database: 'shop', schema: 'public', name: 'orders' }

before(async () => {
  srv = await startTestServer()
  const res = await srv.request('POST', '/api/users', { body: { username: 'viewer', password: 'user-password-123', role: 'user' } })
  assert.equal(res.status, 201, res.text)
})
after(() => srv.close())
beforeEach(() => {
  calls.length = 0
  state = {
    objects: [
      { schema: 'public', name: 'orders', type: 'table' },
      { schema: 'public', name: 'v_orders', type: 'view' },
      { schema: 'public', name: 'log', type: 'table' },
    ],
    structure: {
      columns: [col('id', { type: 'integer', primaryKey: true, editable: false }), col('note'), col('total', { editable: false }), col('photo', { type: 'bytea', editable: false })],
      indexes: [],
      readOnlyReason: null,
    },
    result: () => 1,
  }
})

const patch = (body, opts = {}) => srv.request('PATCH', '/api/explorer/row', { ...opts, body: { ...target, ...body } })
const del = (body, opts = {}) => srv.request('DELETE', '/api/explorer/row', { ...opts, body: { ...target, ...body } })
const update = { key: { id: 4 }, original: { note: 'old' }, changes: { note: 'secret new value' } }

test('structure reports editability, the primary key and editable columns', async () => {
  const res = await srv.request('GET', '/api/explorer/structure?serverId=local&engine=fakeedit&container=db1&database=shop&schema=public&name=orders', asUser)
  assert.equal(res.status, 200, res.text)
  assert.equal(res.json.editable, true)
  assert.equal(res.json.editableReason, null)
  assert.deepEqual(res.json.primaryKey, ['id'])
  assert.deepEqual(res.json.columns.map((c) => [c.name, c.editable]), [['id', false], ['note', true], ['total', false], ['photo', false]])
  assert.ok(!('castType' in res.json.columns[0]))

  const view = await srv.request('GET', '/api/explorer/structure?serverId=local&engine=fakeedit&container=db1&database=shop&schema=public&name=v_orders')
  assert.equal(view.json.editable, false)
  assert.match(view.json.editableReason, /Views are read-only/)
  assert.ok(view.json.columns.every((c) => !c.editable))
})

test('row changes are admin-only', async () => {
  assert.equal((await patch(update, asUser)).status, 403)
  assert.equal((await del({ key: { id: 4 } }, asUser)).status, 403)
  assert.equal(calls.length, 0)
})

test('an update runs as an audit job without the new values', async () => {
  const res = await patch(update)
  assert.equal(res.status, 200, res.text)
  assert.equal(res.json.ok, true)
  assert.deepEqual(calls[0].request, { key: { id: 4 }, original: { note: 'old' }, changes: { note: 'secret new value' } })
  const job = await srv.request('GET', `/api/jobs/${res.json.jobId}`)
  assert.equal(job.json.type, 'explorer-update')
  assert.equal(job.json.status, 'success')
  assert.equal(job.json.username, 'test-admin')
  assert.deepEqual(job.json.meta, {
    serverId: 'local', serverName: job.json.meta.serverName, engine: 'fakeedit', container: 'db1', database: 'shop',
    schema: 'public', object: 'orders', key: { id: 4 }, columns: ['note'],
  })
  assert.ok(!JSON.stringify(job.json).includes('secret new value'))
})

test('a delete matches the key plus the original values; key columns in original must agree', async () => {
  const res = await del({ key: { id: '9007199254740993' }, original: { id: '9007199254740993', note: null, total: '9.50' } })
  assert.equal(res.status, 200, res.text)
  assert.deepEqual(calls[0].request, { key: { id: '9007199254740993' }, original: { note: null, total: '9.50' }, changes: {} })
  const job = await srv.request('GET', `/api/jobs/${res.json.jobId}`)
  assert.equal(job.json.type, 'explorer-delete')
  assert.equal((await del({ key: { id: 4 }, original: { id: 5 } })).status, 400)
})

test('no matching row answers 409 and leaves a failed job', async () => {
  state.result = () => 0
  const res = await patch(update)
  assert.equal(res.status, 409)
  assert.equal(res.json.error, 'This row changed or no longer exists. Reload and try again.')
  const jobs = await srv.request('GET', '/api/jobs?type=explorer-update')
  const failed = jobs.json.jobs ? jobs.json.jobs[0] : jobs.json[0]
  assert.equal(failed.status, 'error')
  assert.match(failed.error, /changed or no longer exists/)
})

test('database errors answer 502 and fail the job with the message', async () => {
  state.result = () => { throw new Error('ERROR:  value too long for type character varying(5)') }
  const res = await del({ key: { id: 4 } })
  assert.equal(res.status, 502)
  assert.match(res.json.error, /value too long/)
  const jobs = await srv.request('GET', '/api/jobs?type=explorer-delete')
  const failed = jobs.json.jobs ? jobs.json.jobs[0] : jobs.json[0]
  assert.equal(failed.status, 'error')
  assert.match(failed.error, /value too long/)
})

test('requests are validated against the catalog before anything runs', async () => {
  const cases = [
    [{ key: {} }, /key is empty/],
    [{ key: { note: 'x' } }, /missing the primary key column id/],
    [{ key: { id: 4, note: 'x' } }, /note is not part of the primary key/],
    [{ key: { id: null } }, /cannot be NULL/],
    [{ changes: { id: 5 }, original: { id: 4 } }, /part of the primary key/],
    [{ changes: { nosuch: 1 }, original: { nosuch: 1 } }, /No column named nosuch/],
    [{ changes: { 'note" = 1; --': 1 }, original: { 'note" = 1; --': 1 } }, /No column named/],
    [{ changes: { total: 1 }, original: { total: 2 } }, /cannot be edited here/],
    [{ changes: { note: 'x' }, original: {} }, /original value of note is missing/],
    [{ changes: {} }, /Nothing to change/],
    [{ changes: { note: 'x' }, original: { note: { truncated: true, value: 'a', length: 9000 } } }, /cut or binary value/],
    [{ key: { id: 4 }, changes: { note: { binary: true, length: 3, preview: 'aa' } } }, /cut or binary value/],
    [{ key: { id: 2 ** 60 } }, /too large/],
    [{ changes: { note: 'x'.repeat(50000) } }, /too large to edit/],
    [{ name: 'v_orders' }, /Views are read-only/],
    [{ name: 'nosuch' }, /No table/],
  ]
  for (const [body, message] of cases) {
    const res = await patch({ ...update, ...body })
    assert.ok([400, 404].includes(res.status), `${JSON.stringify(body).slice(0, 80)}: ${res.status} ${res.text}`)
    assert.match(res.json.error, message)
  }
  state.structure = { ...state.structure, columns: state.structure.columns.map((c) => ({ ...c, primaryKey: false })) }
  const noKey = await patch({ ...update, name: 'log' })
  assert.equal(noKey.status, 400)
  assert.match(noKey.json.error, /no primary key/)
  assert.equal(calls.length, 0)
})

test('MongoDB: _id is the key, $ keys and _id changes are refused, unseen plain fields are accepted', async () => {
  registerAdapter('mongodb', 'docker', {
    supportsQuery: false,
    open: (t, database, fn) => fn({
      objects: async () => [{ schema: null, name: 'users', type: 'collection' }],
      structure: async () => ({ columns: [col('_id', { primaryKey: true, editable: false }), col('name'), col('raw', { editable: false })], indexes: [] }),
      updateRow: async (object, structure, request) => { calls.push({ op: 'update', request }); return 1 },
    }),
  })
  const mongo = { serverId: 'local', engine: 'mongodb', container: 'm1', database: 'shop', name: 'users' }
  const structure = await srv.request('GET', '/api/explorer/structure?serverId=local&engine=mongodb&container=m1&database=shop&name=users')
  assert.deepEqual(structure.json.primaryKey, ['_id'])
  assert.equal(structure.json.editable, true)

  const send = (body) => srv.request('PATCH', '/api/explorer/row', { body: { ...mongo, key: { _id: 'a1' }, ...body } })
  const refused = [
    [{ original: { name: 'a' }, changes: { name: { $set: { admin: true } } } }, /\$ are not allowed/],
    [{ original: { _id: 'a1' }, changes: { _id: 'b2' } }, /primary key/],
    [{ original: { $where: 1 }, changes: { $where: 1 } }, /no leading \$/],
    [{ original: { 'a.b': 1 }, changes: { 'a.b': 2 } }, /no dots/],
    [{ original: { raw: null }, changes: { raw: 'x' } }, /cannot be edited here/],
  ]
  for (const [body, message] of refused) {
    const res = await send(body)
    assert.equal(res.status, 400, res.text)
    assert.match(res.json.error, message)
  }
  assert.equal(calls.length, 0)
  const ok = await send({ original: { extra: null }, changes: { extra: { $date: '2026-10-14T00:00:00Z' } } })
  assert.equal(ok.status, 200, ok.text)
})
