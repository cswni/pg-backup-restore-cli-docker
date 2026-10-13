const fs = require('fs')
const path = require('path')
const { BACKUPS_DIR } = require('./config')
const { getDb, migrate } = require('./db')

// Backup catalog: every file in BACKUPS_DIR that looks like a backup, enriched
// with metadata recorded when the pipeline produced it (engine, source,
// compression, encryption, remote copies). Files without a catalog row
// (uploads, CLI exports, legacy dumps) are still listed.

// Extendable: storage steps register their suffixes (e.g. /\.gz$/).
const backupPatterns = [/\.sql$/i]

function registerBackupPattern(re) {
  backupPatterns.push(re)
}

function isBackupFile(name) {
  return !name.startsWith('.') && backupPatterns.some((re) => re.test(name))
}

function init() {
  migrate('catalog-001-backups', `
    CREATE TABLE backups (
      filename TEXT PRIMARY KEY,
      engine TEXT,
      server_id TEXT,
      container TEXT,
      source_database TEXT,
      job_id TEXT,
      schedule_id TEXT,
      created_at INTEGER NOT NULL,
      size INTEGER,
      sha256 TEXT,
      compressed INTEGER NOT NULL DEFAULT 0,
      encrypted INTEGER NOT NULL DEFAULT 0,
      locations TEXT NOT NULL DEFAULT '[]'
    );
  `)
}

/**
 * Record (or update) metadata for a backup file.
 * @param {object} entry  { filename, engine, serverId, container, sourceDatabase,
 *                          jobId, scheduleId, size, sha256, compressed, encrypted, locations }
 */
function recordBackup(entry) {
  getDb().prepare(`
    INSERT INTO backups (filename, engine, server_id, container, source_database, job_id, schedule_id,
                         created_at, size, sha256, compressed, encrypted, locations)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (filename) DO UPDATE SET
      engine = excluded.engine, server_id = excluded.server_id, container = excluded.container,
      source_database = excluded.source_database, job_id = excluded.job_id,
      schedule_id = excluded.schedule_id, size = excluded.size, sha256 = excluded.sha256,
      compressed = excluded.compressed, encrypted = excluded.encrypted, locations = excluded.locations
  `).run(
    entry.filename, entry.engine || null, entry.serverId || null, entry.container || null,
    entry.sourceDatabase || null, entry.jobId || null, entry.scheduleId || null,
    entry.createdAt || Date.now(), entry.size ?? null, entry.sha256 || null,
    entry.compressed ? 1 : 0, entry.encrypted ? 1 : 0, JSON.stringify(entry.locations || [])
  )
}

function getCatalogEntry(filename) {
  const row = getDb().prepare('SELECT * FROM backups WHERE filename = ?').get(filename)
  return row ? rowToEntry(row) : null
}

function rowToEntry(row) {
  return {
    filename: row.filename,
    engine: row.engine,
    serverId: row.server_id,
    container: row.container,
    sourceDatabase: row.source_database,
    jobId: row.job_id,
    scheduleId: row.schedule_id,
    createdAt: row.created_at,
    sha256: row.sha256,
    compressed: !!row.compressed,
    encrypted: !!row.encrypted,
    locations: JSON.parse(row.locations || '[]'),
  }
}

/** All backups on disk, newest first, merged with catalog metadata. */
function listBackups() {
  if (!fs.existsSync(BACKUPS_DIR)) return []
  const rows = new Map(getDb().prepare('SELECT * FROM backups').all().map((r) => [r.filename, rowToEntry(r)]))
  return fs.readdirSync(BACKUPS_DIR)
    .filter(isBackupFile)
    .map((name) => {
      const stat = fs.statSync(path.join(BACKUPS_DIR, name))
      if (!stat.isFile()) return null
      return { ...rows.get(name), name, size: stat.size, mtime: stat.mtimeMs }
    })
    .filter(Boolean)
    .sort((a, b) => b.mtime - a.mtime)
}

/** Absolute path of a backup file, guarding against path traversal. */
function backupPath(filename) {
  const base = path.basename(String(filename))
  if (!base || base !== filename || !isBackupFile(base)) {
    const err = new Error(`Invalid backup file name: ${filename}`)
    err.status = 400
    throw err
  }
  return path.join(BACKUPS_DIR, base)
}

function removeCatalogEntry(filename) {
  getDb().prepare('DELETE FROM backups WHERE filename = ?').run(filename)
}

module.exports = {
  init, isBackupFile, registerBackupPattern, recordBackup, getCatalogEntry,
  listBackups, backupPath, removeCatalogEntry,
}
