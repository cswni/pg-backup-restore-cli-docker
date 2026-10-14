const { httpError } = require('../validation')

// Explorer adapters, one per engine and server kind (like drivers/index.js).
//
// adapter = {
//   supportsQuery: boolean,           // SQL console available
//   open(target, database, fn)        // fn(session) runs with one connection
// }
// session = {
//   objects()                    -> [{ schema, name, type, rows, sizeBytes }]
//   structure(object)            -> { columns, indexes }
//   rows(object, { limit, offset, sort, dir, filter, structure })
//                                -> { columns, rows }   at most limit + 1 rows
//   query(sql, limit)            -> { columns, rows }   at most limit + 1 rows
// }
// `object` always comes from objects(), so names used in SQL exist in the
// catalog. Rows are returned already shaped as cells (see cells.js).

const adapters = new Map()

function registerAdapter(engine, kind, adapter) {
  adapters.set(`${engine}:${kind}`, adapter)
}

function getAdapter(engine, kind) {
  const adapter = adapters.get(`${engine}:${kind}`)
  if (!adapter) throw httpError(400, `The explorer does not support ${engine} on ${kind} servers`)
  return adapter
}

registerAdapter('postgres', 'docker', require('./postgres').dockerAdapter)
registerAdapter('postgres', 'direct', require('./postgres').directAdapter)
registerAdapter('mysql', 'docker', require('./mysql').dockerAdapter)
registerAdapter('mysql', 'direct', require('./mysql').directAdapter)
registerAdapter('mongodb', 'docker', require('./mongodb-docker').adapter)
registerAdapter('mongodb', 'direct', require('./mongodb-direct').adapter)

module.exports = { registerAdapter, getAdapter }
