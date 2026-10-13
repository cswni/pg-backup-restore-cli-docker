const fs = require('fs')
const os = require('os')
const path = require('path')
const childProcess = require('child_process')
const { withConnection } = require('../connectivity/tunnel')
const { capture, toolEnv } = require('../connectivity/process')
const { createMongoDriver, SYSTEM_DATABASES } = require('./mongodb-common')

// MongoDB reached directly over TCP (optionally through an SSH tunnel).
//   - dump / restore: mongodump / mongorestore of this image (mongodb-tools).
//     The connection string, including credentials, is written to a private
//     YAML file (mode 0600 in a fresh temp directory, deleted afterwards)
//     passed with --config, so nothing secret is on the command line.
//   - list / count / drop / version: the official Node.js driver (`mongodb`),
//     because mongosh is not part of the image.
// The server's "maintenance database" is used as authSource (default admin).
// Connections use directConnection=true: point the server at the primary.

const SERVER_SELECTION_TIMEOUT_MS = 10000
const TOOL_TIMEOUT_MS = 30000

let clientFactory = (uri, options) => new (require('mongodb').MongoClient)(uri, options)

/** TLS URI options from the server's sslmode. */
function tlsParams(conn) {
  switch (conn.sslmode) {
    case 'require': return { tls: 'true', tlsInsecure: 'true' }
    case 'verify-full':
      if (conn.tlsServerName) throw new Error("sslmode 'verify-full' is not supported through an SSH tunnel for MongoDB – use 'require'.")
      return { tls: 'true' }
    default: return {} // disable / prefer: MongoDB has no opportunistic TLS
  }
}

/**
 * mongodb:// URI for a connection from withConnection().
 * @param {object} conn
 * @param {{ credentials?: boolean }} [opts]  include user:password (only for the private --config file)
 */
function buildUri(conn, { credentials = false } = {}) {
  const host = String(conn.host).includes(':') ? `[${conn.host}]` : conn.host
  const auth = credentials && conn.username
    ? `${encodeURIComponent(conn.username)}${conn.password ? `:${encodeURIComponent(conn.password)}` : ''}@`
    : ''
  const params = new URLSearchParams({ directConnection: 'true', ...tlsParams(conn) })
  if (conn.username) params.set('authSource', conn.database || 'admin')
  return `mongodb://${auth}${host}:${conn.port}/?${params}`
}

/** Single-quoted YAML scalar. */
function yamlString(value) {
  return `'${String(value).replace(/'/g, "''")}'`
}

function writeToolConfig(conn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pgui-mongo-'))
  const file = path.join(dir, 'tools.yaml')
  fs.writeFileSync(file, `uri: ${yamlString(buildUri(conn, { credentials: true }))}\n`, { mode: 0o600 })
  return { file, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) }
}

/** Node.js driver client; created on first use. */
function lazyClient(conn) {
  let client = null
  return {
    async get() {
      if (!client) {
        const auth = conn.username ? { auth: { username: conn.username, password: conn.password || '' } } : {}
        client = clientFactory(buildUri(conn), { ...auth, serverSelectionTimeoutMS: SERVER_SELECTION_TIMEOUT_MS, appName: 'pg-backup-ui' })
        await client.connect()
      }
      return client
    },
    async close() {
      if (client) await client.close().catch(() => {})
    },
  }
}

async function toolVersion() {
  const out = await capture('mongodump', ['--version'], { env: toolEnv(), timeout: TOOL_TIMEOUT_MS })
  return out.split('\n')[0].trim()
}

function runner(client, configFile) {
  return {
    spawn: (tool, args) => childProcess.spawn(tool, [`--config=${configFile}`, ...args], { env: toolEnv() }),
    async listDatabases() {
      const { databases } = await (await client.get()).db('admin').admin().listDatabases({ nameOnly: true })
      return databases.map((d) => d.name)
    },
    async countCollections(database) {
      const list = await (await client.get()).db(database).listCollections({}, { nameOnly: true }).toArray()
      return list.filter((c) => !c.name.startsWith('system.')).length
    },
    async dropDatabase(database) {
      await (await client.get()).db(database).dropDatabase()
    },
    async version() {
      const info = await (await client.get()).db('admin').admin().serverInfo()
      return `${info.version} · ${await toolVersion()}`
    },
  }
}

function open(target, fn, opts) {
  return withConnection(target.server, async (conn) => {
    const config = writeToolConfig(conn)
    const client = lazyClient(conn)
    try {
      return await fn(runner(client, config.file))
    } finally {
      config.cleanup()
      await client.close()
    }
  }, opts)
}

module.exports = {
  ...createMongoDriver({ kind: 'direct', open }),
  _internals: {
    buildUri, yamlString, tlsParams, SYSTEM_DATABASES,
    setClientFactory(fn) { clientFactory = fn },
  },
}
