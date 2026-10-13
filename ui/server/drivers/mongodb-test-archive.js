// Test support: builds minimal mongodump archives (magic, header, collection
// metadata, terminator, fake data) for MongoDB driver tests.
const { MAGIC } = require('./mongodb-archive')

/** BSON document with string, int32 and boolean values. */
function bson(fields) {
  const parts = Object.entries(fields).map(([name, value]) => {
    const key = Buffer.from(`${name}\0`)
    if (typeof value === 'string') {
      const str = Buffer.from(`${value}\0`)
      const len = Buffer.alloc(4)
      len.writeInt32LE(str.length)
      return Buffer.concat([Buffer.from([0x02]), key, len, str])
    }
    if (typeof value === 'boolean') return Buffer.concat([Buffer.from([0x08]), key, Buffer.from([value ? 1 : 0])])
    const n = Buffer.alloc(4)
    n.writeInt32LE(value)
    return Buffer.concat([Buffer.from([0x10]), key, n])
  })
  const body = Buffer.concat([...parts, Buffer.from([0])])
  const size = Buffer.alloc(4)
  size.writeInt32LE(body.length + 4)
  return Buffer.concat([size, body])
}

/**
 * @param {[string, string][]} namespaces  [db, collection] pairs
 * @returns {Buffer}
 */
function buildArchive(namespaces) {
  const magic = Buffer.alloc(4)
  magic.writeUInt32LE(MAGIC)
  const header = bson({ concurrent_collections: 4, version: '0.1', server_version: '8.0.4', tool_version: '100.10.0' })
  const metas = namespaces.map(([db, collection]) => bson({ db, collection, metadata: '{"indexes":[]}', size: 0, type: 'collection' }))
  const terminator = Buffer.from([0xff, 0xff, 0xff, 0xff])
  return Buffer.concat([magic, header, ...metas, terminator, bson({ db: namespaces[0]?.[0] || 'x', collection: 'data', EOF: false })])
}

module.exports = { buildArchive, bson }
