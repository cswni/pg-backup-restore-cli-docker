const { withConnection } = require('../connectivity/tunnel')
const { _internals: { buildUri } } = require('../drivers/mongodb-direct')
const bson = require('./mongodb-bson')
const edit = require('./mongodb-edit')

// MongoDB explorer for direct servers, through the Node.js driver. Same
// connection settings as drivers/mongodb-direct.js: credentials are client
// options, never part of a URI or command line.

const SERVER_SELECTION_TIMEOUT_MS = 10000
// Wrapper types (Int32, Long, Binary…) so values look the same as from mongosh.
const RAW_VALUES = { promoteValues: false, promoteBuffers: false }

let clientFactory = (uri, options) => new (require('mongodb').MongoClient)(uri, options)

/** Collections and views with estimated counts and storage size. */
async function listObjects(db) {
  const infos = await db.listCollections({}, { nameOnly: false }).toArray()
  const objects = []
  for (const info of infos.filter((i) => !i.name.startsWith('system.')).sort((a, b) => a.name.localeCompare(b.name))) {
    if (info.type === 'view') {
      objects.push({ schema: null, name: info.name, type: 'view', rows: null, sizeBytes: null })
      continue
    }
    const coll = db.collection(info.name)
    const rows = await coll.estimatedDocumentCount({ maxTimeMS: bson.MAX_TIME_MS }).catch(() => null)
    const sizeBytes = await coll.aggregate([{ $collStats: { storageStats: {} } }], { maxTimeMS: bson.MAX_TIME_MS }).toArray()
      .then(([s]) => s?.storageStats?.storageSize ?? null, () => null)
    objects.push({ schema: null, name: info.name, type: 'collection', rows, sizeBytes: sizeBytes === null ? null : Number(sizeBytes) })
  }
  return objects
}

function createSession(db) {
  const store = {
    find: (object, filter, limit) => db.collection(object.name).find(filter, { limit, maxTimeMS: bson.MAX_TIME_MS, ...RAW_VALUES }).toArray(),
    updateOne: (object, filter, update) => db.collection(object.name).updateOne(filter, update),
    deleteOne: (object, filter) => db.collection(object.name).deleteOne(filter),
  }
  return {
    updateRow: (object, structure, request) => edit.updateRow(store, object, request),
    deleteRow: (object, structure, request) => edit.deleteRow(store, object, request),
    objects: () => listObjects(db),
    async structure(object) {
      const coll = db.collection(object.name)
      const sample = await coll.find({}, { limit: bson.SAMPLE_SIZE, maxTimeMS: bson.MAX_TIME_MS, ...RAW_VALUES }).toArray()
      const indexes = object.type === 'view' ? [] : await coll.listIndexes().toArray()
      return bson.toStructure(sample, indexes)
    },
    async rows(object, opts) {
      const filter = bson.parseFilter(opts.filter)
      const docs = await db.collection(object.name).find(filter, { ...bson.findOptions(opts), ...RAW_VALUES }).toArray()
      return bson.docsToRows(docs)
    },
  }
}

const adapter = {
  supportsQuery: false,
  open(target, database, fn) {
    return withConnection(target.server, async (conn) => {
      const auth = conn.username ? { auth: { username: conn.username, password: conn.password || '' } } : {}
      const client = clientFactory(buildUri(conn), { ...auth, serverSelectionTimeoutMS: SERVER_SELECTION_TIMEOUT_MS, appName: 'pg-backup-ui' })
      try {
        await client.connect()
        return await fn(createSession(client.db(database)))
      } finally {
        await client.close().catch(() => {})
      }
    })
  },
}

module.exports = {
  adapter,
  createSession,
  setClientFactory(fn) { clientFactory = fn },
}
