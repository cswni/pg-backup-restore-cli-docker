const { setupTestEnv } = require('../test-helpers')
setupTestEnv()

const { test, mock, beforeEach } = require('node:test')
const assert = require('node:assert/strict')
const { BSON } = require('mongodb')
const bson = require('./mongodb-bson')
const mongoDocker = require('./mongodb-docker')
const mongoDirect = require('./mongodb-direct')
const { installSpawnFake } = require('./test-fakes')

const { ObjectId, Int32, Long, Double, Binary, Decimal128, Code } = BSON
const fake = installSpawnFake(mock, ['docker'])
beforeEach(() => { fake.calls.length = 0; fake.respond(() => '') })

test('parseFilter reads Extended JSON objects', () => {
  assert.deepEqual(bson.parseFilter(''), {})
  assert.deepEqual(bson.parseFilter(null), {})
  const filter = bson.parseFilter('{"_id": {"$oid": "0123456789abcdef01234567"}, "n": {"$gt": 3}}')
  assert.ok(filter._id instanceof ObjectId)
  assert.deepEqual(filter.n, { $gt: 3 })
})

test('parseFilter refuses non-objects and operators that run JavaScript', () => {
  for (const text of ['[1]', '"x"', '42', 'null', '{not json']) {
    assert.throws(() => bson.parseFilter(text), (err) => err.status === 400, text)
  }
  assert.throws(() => bson.parseFilter('{"$where": "sleep(1000)"}'), /\$where is not allowed/)
  assert.throws(() => bson.parseFilter('{"$or": [{"a": 1}, {"$expr": {"$function": {"body": "x", "args": [], "lang": "js"}}}]}'), /\$function/)
  assert.throws(() => bson.parseFilter('{"g": {"$accumulator": {}}}'), /\$accumulator/)
  assert.throws(() => bson.parseFilter('{"a": {"$code": "function () {}"}}'), /JavaScript code/)
})

test('bsonType names match the $type operator', () => {
  const values = [new ObjectId(), new Int32(1), new Double(1.5), Long.fromNumber(5), Decimal128.fromString('1.1'),
    new Binary(Buffer.from([1])), new Date(), 's', true, null, [1], { a: 1 }, new Code('x')]
  assert.deepEqual(values.map(bson.bsonType),
    ['objectId', 'int', 'double', 'long', 'decimal', 'binData', 'date', 'string', 'bool', 'null', 'array', 'object', 'javascript'])
})

test('mongoCell turns BSON into JSON cells', () => {
  const id = new ObjectId('0123456789abcdef01234567')
  assert.equal(bson.mongoCell(id), '0123456789abcdef01234567')
  assert.equal(bson.mongoCell(new Int32(7)), 7)
  assert.equal(bson.mongoCell(Long.fromString('9007199254740993')), '9007199254740993')
  assert.equal(bson.mongoCell(new Date(0)), '1970-01-01T00:00:00.000Z')
  assert.equal(bson.mongoCell(undefined), null)
  const bytes = Buffer.alloc(40, 0xab)
  assert.deepEqual(bson.mongoCell(new Binary(bytes)), { binary: true, length: 40, preview: 'ab'.repeat(32) })
  assert.deepEqual(bson.mongoCell({ n: new Int32(1), when: new Date(0) }), { n: 1, when: '1970-01-01T00:00:00.000Z' })
  assert.deepEqual(bson.mongoCell('q'.repeat(2001)), { truncated: true, value: 'q'.repeat(2000), length: 2001 })
  const nested = bson.mongoCell({ list: Array.from({ length: 500 }, (_, i) => `item-${i}`) })
  assert.equal(nested.truncated, true)
})

test('docsToRows unions fields with _id first', () => {
  const docs = [{ name: 'a', _id: new Int32(1) }, { _id: new Int32(2), extra: true }]
  assert.deepEqual(bson.docsToRows(docs), { columns: ['_id', 'name', 'extra'], rows: [[1, 'a', null], [2, null, true]] })
})

test('toStructure reports observed types, missing fields as nullable and indexes', () => {
  const sample = [{ _id: new ObjectId(), qty: new Int32(1) }, { _id: new ObjectId(), qty: new Double(1.5), tag: 'x', raw: new Binary(Buffer.from([1])) }]
  const indexes = [{ name: '_id_', key: { _id: 1 } }, { name: 'tag_qty', key: { tag: 1, qty: -1 }, unique: true }]
  assert.deepEqual(bson.toStructure(sample, indexes), {
    columns: [
      { name: '_id', type: 'objectId', nullable: false, default: null, primaryKey: true, editable: false },
      { name: 'qty', type: 'int|double', nullable: false, default: null, primaryKey: false, editable: true },
      { name: 'tag', type: 'string', nullable: true, default: null, primaryKey: false, editable: true },
      { name: 'raw', type: 'binData', nullable: true, default: null, primaryKey: false, editable: false },
    ],
    indexes: [{ name: '_id_', columns: ['_id'], unique: true }, { name: 'tag_qty', columns: ['tag', 'qty'], unique: true }],
  })
})

test('findOptions sorts by _id unless a field is chosen and fetches one extra document', () => {
  assert.deepEqual(bson.findOptions({ limit: 50, offset: 100 }), { sort: { _id: 1 }, skip: 100, limit: 51, maxTimeMS: 10000 })
  assert.deepEqual(bson.findOptions({ limit: 5, offset: 0, sort: 'qty', dir: 'desc' }).sort, { qty: -1 })
})

const dockerTarget = { server: { id: 'local', name: 'Local Docker', kind: 'docker', builtin: true, dockerHost: null }, container: 'mongo7' }
const shellOut = (result) => `Some banner\n${BSON.EJSON.stringify({ result }, { relaxed: false })}\n`

test('Docker: user input travels in PGUI_ACTION, never in the program text', async () => {
  fake.respond(() => shellOut([{ _id: new Int32(1), name: 'a' }]))
  const filter = '{"name": {"$in": ["\\"); db.dropDatabase(); (\\""]}}'
  const page = await mongoDocker.adapter.open(dockerTarget, 'shop', (s) => s.rows({ name: 'orders', type: 'collection' }, { limit: 10, offset: 0, filter }))
  assert.deepEqual(page, { columns: ['_id', 'name'], rows: [[1, 'a']] })
  const [call] = fake.calls
  assert.deepEqual(call.args.slice(0, 4), ['exec', 'mongo7', 'sh', '-c'])
  assert.equal(call.args[5], 'sh')
  assert.equal(call.args[6], 'shell')
  assert.equal(call.args[7], mongoDocker.EXPLORER_JS)
  const action = JSON.parse(call.args[8])
  assert.equal(action.op, 'rows')
  assert.equal(action.collection, 'orders')
  assert.deepEqual(BSON.EJSON.parse(action.filter), { name: { $in: ['"); db.dropDatabase(); ("'] } })
  assert.equal(call.args[9], 'shop')
})

test('Docker: objects keep counts as numbers', async () => {
  fake.respond(() => shellOut([
    { name: 'b', type: 'collection', rows: new Int32(3), sizeBytes: Long.fromNumber(4096) },
    { name: 'a', type: 'view', rows: null, sizeBytes: null },
  ]))
  const objects = await mongoDocker.adapter.open(dockerTarget, 'shop', (s) => s.objects())
  assert.deepEqual(objects, [
    { schema: null, name: 'a', type: 'view', rows: null, sizeBytes: null },
    { schema: null, name: 'b', type: 'collection', rows: 3, sizeBytes: 4096 },
  ])
})

test('Docker: mongosh failures reject with its message', async () => {
  fake.respond(() => ({ stderr: 'MongoServerError: Authentication failed.', code: 1 }))
  await assert.rejects(mongoDocker.adapter.open(dockerTarget, 'shop', (s) => s.objects()), /Authentication failed/)
  assert.throws(() => mongoDocker.parseShellResult('nothing useful'), /Unexpected mongosh output/)
})

test('direct: uses the Node.js driver with credentials as client options', async () => {
  const created = []
  const found = []
  mongoDirect.setClientFactory((uri, options) => {
    created.push({ uri, options })
    const collection = (name) => ({
      estimatedDocumentCount: async () => 12,
      aggregate: () => ({ toArray: async () => [{ storageStats: { storageSize: 8192 } }] }),
      find: (filter, opts) => { found.push({ name, filter, opts }); return { toArray: async () => [{ _id: new Int32(1) }] } },
      listIndexes: () => ({ toArray: async () => [{ name: '_id_', key: { _id: 1 } }] }),
    })
    const db = {
      listCollections: () => ({ toArray: async () => [{ name: 'orders', type: 'collection' }, { name: 'system.views' }, { name: 'recent', type: 'view' }] }),
      collection,
    }
    return { connect: async () => {}, db: () => db, close: async () => {} }
  })
  const server = { id: 'mg1', name: 'prod', kind: 'direct', engine: 'mongodb', host: 'm.example.com', port: 27017, username: 'reader', password: 'p@ss', database: 'admin', sslmode: 'prefer', tunnel: null }
  const objects = await mongoDirect.adapter.open({ server }, 'shop', (s) => s.objects())
  assert.deepEqual(objects, [
    { schema: null, name: 'orders', type: 'collection', rows: 12, sizeBytes: 8192 },
    { schema: null, name: 'recent', type: 'view', rows: null, sizeBytes: null },
  ])
  assert.ok(!created[0].uri.includes('p@ss'))
  assert.deepEqual(created[0].options.auth, { username: 'reader', password: 'p@ss' })

  await mongoDirect.adapter.open({ server }, 'shop', (s) => s.rows({ name: 'orders' }, { limit: 5, offset: 10, filter: '{"a": 1}' }))
  assert.deepEqual(found[0].filter, { a: 1 })
  assert.equal(found[0].opts.limit, 6)
  assert.equal(found[0].opts.promoteValues, false)
})
