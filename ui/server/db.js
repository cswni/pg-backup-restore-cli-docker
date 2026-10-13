const fs = require('fs')
const path = require('path')
const { DatabaseSync } = require('node:sqlite')
const { DATA_DIR } = require('./config')

let db = null

/**
 * Shared SQLite connection (node:sqlite, synchronous API).
 * Modules create their own tables with `migrate()` at startup.
 */
function getDb() {
  if (db) return db
  fs.mkdirSync(DATA_DIR, { recursive: true })
  db = new DatabaseSync(process.env.DB_PATH || path.join(DATA_DIR, 'app.db'))
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;')
  db.exec(`CREATE TABLE IF NOT EXISTS migrations (
    name TEXT PRIMARY KEY,
    applied_at INTEGER NOT NULL
  )`)
  return db
}

/**
 * Apply a named migration once. Names must be globally unique; prefix them
 * with the owning module, e.g. "auth-001-users".
 */
function migrate(name, sql) {
  const conn = getDb()
  const done = conn.prepare('SELECT 1 FROM migrations WHERE name = ?').get(name)
  if (done) return
  conn.exec('BEGIN')
  try {
    conn.exec(sql)
    conn.prepare('INSERT INTO migrations (name, applied_at) VALUES (?, ?)').run(name, Date.now())
    conn.exec('COMMIT')
  } catch (err) {
    conn.exec('ROLLBACK')
    throw new Error(`Migration ${name} failed: ${err.message}`)
  }
}

/** Test helper: point at a fresh database (e.g. ':memory:'). */
function resetDbForTests(file = ':memory:') {
  if (db) db.close()
  db = new DatabaseSync(file)
  db.exec('PRAGMA foreign_keys = ON;')
  db.exec('CREATE TABLE IF NOT EXISTS migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)')
  return db
}

module.exports = { getDb, migrate, resetDbForTests }
