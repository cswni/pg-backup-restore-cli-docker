const fs = require('fs')
const zlib = require('zlib')

// Reads the prelude of a `mongodump --archive` file to find out which
// database(s) it contains, so a restore can rename `<source>.*` to
// `<target>.*` without relying on the catalog (uploads have no catalog row).
//
// Archive layout (mongo-tools archive/prelude.go):
//   int32 magic 0x8199e26d | BSON header | BSON collection metadata… | int32 -1
// Each metadata document has `db` and `collection` string fields. Archives
// written with `mongodump --gzip --archive` are gzip streams as a whole.

const MAGIC = 0x8199e26d
const TERMINATOR = 0xffffffff
const MAX_PRELUDE_BYTES = 64 * 1024 * 1024

/** Top-level string fields of one BSON document (other types are skipped). */
function bsonStrings(buf, offset) {
  const size = buf.readInt32LE(offset)
  const end = offset + size
  const result = {}
  let i = offset + 4
  while (i < end - 1) {
    const type = buf[i]
    const nameEnd = buf.indexOf(0, i + 1)
    const name = buf.toString('utf8', i + 1, nameEnd)
    i = nameEnd + 1
    if (type === 0x02) result[name] = buf.toString('utf8', i + 4, i + 4 + buf.readInt32LE(i) - 1)
    i += valueSize(buf, type, i)
  }
  return result
}

const FIXED_SIZES = { 0x01: 8, 0x07: 12, 0x08: 1, 0x09: 8, 0x0a: 0, 0x10: 4, 0x11: 8, 0x12: 8, 0x13: 16, 0x06: 0, 0xff: 0, 0x7f: 0 }

function valueSize(buf, type, i) {
  if (type in FIXED_SIZES) return FIXED_SIZES[type]
  switch (type) {
    case 0x02: case 0x0d: case 0x0e: return 4 + buf.readInt32LE(i)
    case 0x03: case 0x04: case 0x0f: return buf.readInt32LE(i)
    case 0x05: return 5 + buf.readInt32LE(i)
    case 0x0b: { const a = buf.indexOf(0, i); return buf.indexOf(0, a + 1) + 1 - i }
    case 0x0c: return 4 + buf.readInt32LE(i) + 12
    default: throw new Error(`Unsupported BSON type 0x${type.toString(16)} in archive prelude`)
  }
}

/**
 * Parse the prelude from the start of an archive.
 * @param {Buffer} buf
 * @returns {{ namespaces: { db: string, collection: string }[] } | null}  null = need more bytes
 */
function parsePrelude(buf) {
  if (buf.length < 4) return null
  if (buf.readUInt32LE(0) !== MAGIC) throw new Error('Not a mongodump archive (bad magic number)')
  let offset = 4
  let headerSeen = false
  const namespaces = []
  for (;;) {
    if (buf.length < offset + 4) return null
    if (buf.readUInt32LE(offset) === TERMINATOR) return { namespaces }
    const size = buf.readInt32LE(offset)
    if (size < 5) throw new Error('Corrupt mongodump archive prelude')
    if (buf.length < offset + size) return null
    if (headerSeen) {
      const doc = bsonStrings(buf, offset)
      if (doc.db) namespaces.push({ db: doc.db, collection: doc.collection || '' })
    }
    headerSeen = true
    offset += size
  }
}

/** Collect namespaces in a stream until the prelude is complete. */
function readPrelude(stream) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let length = 0
    const done = (err, value) => { stream.destroy(); err ? reject(err) : resolve(value) }
    stream.on('data', (chunk) => {
      chunks.push(chunk)
      length += chunk.length
      try {
        const result = parsePrelude(Buffer.concat(chunks, length))
        if (result) return done(null, result)
        if (length > MAX_PRELUDE_BYTES) done(new Error('mongodump archive prelude is too large'))
      } catch (err) { done(err) }
    })
    stream.on('error', (err) => done(err))
    stream.on('end', () => done(new Error('Truncated mongodump archive (prelude incomplete)')))
  })
}

function isGzip(file) {
  const fd = fs.openSync(file, 'r')
  try {
    const head = Buffer.alloc(2)
    return fs.readSync(fd, head, 0, 2, 0) === 2 && head[0] === 0x1f && head[1] === 0x8b
  } finally {
    fs.closeSync(fd)
  }
}

/**
 * Inspect an archive file.
 * @param {string} file
 * @returns {Promise<{ gzip: boolean, databases: string[], namespaces: object[] }>}
 *   `databases` excludes the admin users/roles collections (--dumpDbUsersAndRoles).
 */
async function inspectArchive(file) {
  const gzip = isGzip(file)
  const input = fs.createReadStream(file)
  const stream = gzip ? input.pipe(zlib.createGunzip()) : input
  if (gzip) stream.on('close', () => input.destroy())
  const { namespaces } = await readPrelude(stream)
  const databases = [...new Set(namespaces
    .filter((ns) => !(ns.db === 'admin' && ns.collection.startsWith('system.')))
    .map((ns) => ns.db))]
  return { gzip, databases, namespaces }
}

module.exports = { inspectArchive, parsePrelude, MAGIC }
