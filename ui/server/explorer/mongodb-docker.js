const { BSON } = require('mongodb')
const { execEnv } = require('../servers')
const { capture } = require('../connectivity/process')
const { _internals: { execArgs } } = require('../drivers/mongodb-docker')
const bson = require('./mongodb-bson')

// MongoDB explorer for Docker servers: the container's mongosh runs a fixed
// program through the backup driver's shell wrapper (credentials from the
// container's environment). The request travels as JSON in an environment
// variable (PGUI_ACTION) and the filter as Extended JSON inside it, so user
// input is never part of the program text. Results come back as canonical
// Extended JSON to keep BSON types.

const SHELL_TIMEOUT_MS = 30000

const EXPLORER_JS = String.raw`
const env = process.env
const admin = db.getSiblingDB('admin')
if (env.PGUI_USER) admin.auth(env.PGUI_USER, env.PGUI_PASSWORD)
const req = JSON.parse(env.PGUI_ACTION)
const target = db.getSiblingDB(env.PGUI_DB)
const maxTimeMS = req.maxTimeMS
let result
if (req.op === 'objects') {
  result = target.getCollectionInfos({}).filter((i) => !i.name.startsWith('system.')).map((info) => {
    if (info.type === 'view') return { name: info.name, type: 'view', rows: null, sizeBytes: null }
    const coll = target.getCollection(info.name)
    let rows = null
    let sizeBytes = null
    try { rows = coll.estimatedDocumentCount({ maxTimeMS }) } catch (e) { rows = null }
    try {
      const stats = coll.aggregate([{ $collStats: { storageStats: {} } }], { maxTimeMS }).toArray()[0]
      sizeBytes = stats && stats.storageStats ? stats.storageStats.storageSize : null
    } catch (e) { sizeBytes = null }
    return { name: info.name, type: 'collection', rows, sizeBytes }
  })
} else if (req.op === 'structure') {
  const coll = target.getCollection(req.collection)
  result = {
    sample: coll.find({}).limit(req.sampleSize).maxTimeMS(maxTimeMS).toArray(),
    indexes: req.isView ? [] : coll.getIndexes(),
  }
} else if (req.op === 'rows') {
  const filter = EJSON.parse(req.filter, { relaxed: false })
  result = target.getCollection(req.collection).find(filter).sort(req.sort).skip(req.skip).limit(req.limit)
    .maxTimeMS(maxTimeMS).toArray()
} else {
  throw new Error('unknown explorer request ' + req.op)
}
print(EJSON.stringify({ result }, { relaxed: false }))
`

/** The `{"result": …}` line printed by EXPLORER_JS, with BSON types restored. */
function parseShellResult(out) {
  const line = out.trim().split('\n').reverse().find((l) => l.trim().startsWith('{"result"'))
  if (!line) throw new Error(`Unexpected mongosh output: ${out.trim().slice(0, 200)}`)
  return BSON.EJSON.parse(line, { relaxed: false }).result
}

const toNumber = (v) => (v === null || v === undefined ? null : Number(bson.toJson(v)))

/**
 * Session over `shell(request)`, which runs EXPLORER_JS with the request.
 * @param {(request: object) => Promise<any>} shell
 */
function createSession(shell) {
  return {
    async objects() {
      const list = await shell({ op: 'objects' })
      return list
        .map((o) => ({ schema: null, name: o.name, type: o.type, rows: toNumber(o.rows), sizeBytes: toNumber(o.sizeBytes) }))
        .sort((a, b) => a.name.localeCompare(b.name))
    },
    async structure(object) {
      const { sample, indexes } = await shell({
        op: 'structure', collection: object.name, sampleSize: bson.SAMPLE_SIZE, isView: object.type === 'view',
      })
      return bson.toStructure(sample, indexes)
    },
    async rows(object, opts) {
      const filter = BSON.EJSON.stringify(bson.parseFilter(opts.filter), { relaxed: false })
      const { sort, skip, limit } = bson.findOptions(opts)
      return bson.docsToRows(await shell({ op: 'rows', collection: object.name, filter, sort, skip, limit }))
    },
  }
}

const adapter = {
  supportsQuery: false,
  async open(target, database, fn) {
    const env = { ...process.env, ...(await execEnv(target.server)) }
    const shell = async (request) => {
      const action = JSON.stringify({ ...request, maxTimeMS: bson.MAX_TIME_MS })
      const out = await capture('docker', execArgs(target, 'shell', [EXPLORER_JS, action, database]), { env, timeout: SHELL_TIMEOUT_MS })
      return parseShellResult(out)
    }
    return fn(createSession(shell))
  },
}

module.exports = { adapter, createSession, parseShellResult, EXPLORER_JS }
