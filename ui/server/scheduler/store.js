const { randomUUID } = require('crypto')
const { getDb, migrate } = require('../db')

// Persistence for backup schedules.

function migrateSchedules() {
  migrate('scheduler-001-schedules', `
    CREATE TABLE schedules (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      cron TEXT NOT NULL,
      timezone TEXT NOT NULL,
      server_id TEXT NOT NULL,
      engine TEXT NOT NULL,
      container TEXT,
      database TEXT NOT NULL,
      output_name TEXT,
      options TEXT NOT NULL DEFAULT '{}',
      created_by TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_run_at INTEGER,
      last_job_id TEXT,
      last_status TEXT,
      next_run_at INTEGER
    );
    CREATE INDEX schedules_next_run ON schedules (enabled, next_run_at);
  `)
}

function rowToSchedule(row) {
  return {
    id: row.id,
    name: row.name,
    enabled: !!row.enabled,
    cron: row.cron,
    timezone: row.timezone,
    serverId: row.server_id,
    engine: row.engine,
    container: row.container,
    database: row.database,
    outputName: row.output_name,
    options: JSON.parse(row.options || '{}'),
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastRunAt: row.last_run_at,
    lastJobId: row.last_job_id,
    lastStatus: row.last_status,
    nextRunAt: row.next_run_at,
  }
}

/** @returns {object[]} all schedules ordered by name */
function listSchedules() {
  return getDb().prepare('SELECT * FROM schedules ORDER BY name COLLATE NOCASE, created_at').all().map(rowToSchedule)
}

/** @returns {object|null} */
function getSchedule(id) {
  const row = getDb().prepare('SELECT * FROM schedules WHERE id = ?').get(String(id))
  return row ? rowToSchedule(row) : null
}

/** Enabled schedules whose next run is at or before `now`. */
function dueSchedules(now) {
  return getDb().prepare(
    'SELECT * FROM schedules WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at'
  ).all(now).map(rowToSchedule)
}

/**
 * Insert a validated schedule.
 * @param {object} s  normalized fields (see validate.normalizeSchedule) plus nextRunAt
 * @param {{ username?: string }} user
 * @param {number} now
 * @returns {object} stored schedule
 */
function insertSchedule(s, user, now) {
  const id = randomUUID()
  getDb().prepare(`
    INSERT INTO schedules (id, name, enabled, cron, timezone, server_id, engine, container, database,
                           output_name, options, created_by, created_at, updated_at, next_run_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, s.name, s.enabled ? 1 : 0, s.cron, s.timezone, s.serverId, s.engine, s.container ?? null,
    s.database, s.outputName ?? null, JSON.stringify(s.options || {}), user?.username ?? null,
    now, now, s.nextRunAt ?? null
  )
  return getSchedule(id)
}

/** Replace the editable fields of a schedule. */
function updateSchedule(id, s, now) {
  getDb().prepare(`
    UPDATE schedules SET name = ?, enabled = ?, cron = ?, timezone = ?, server_id = ?, engine = ?,
      container = ?, database = ?, output_name = ?, options = ?, updated_at = ?, next_run_at = ?
    WHERE id = ?
  `).run(
    s.name, s.enabled ? 1 : 0, s.cron, s.timezone, s.serverId, s.engine, s.container ?? null,
    s.database, s.outputName ?? null, JSON.stringify(s.options || {}), now, s.nextRunAt ?? null, id
  )
  return getSchedule(id)
}

function deleteSchedule(id) {
  return getDb().prepare('DELETE FROM schedules WHERE id = ?').run(String(id)).changes > 0
}

function setNextRun(id, nextRunAt) {
  getDb().prepare('UPDATE schedules SET next_run_at = ? WHERE id = ?').run(nextRunAt, id)
}

/** Record that a run started (or failed to start, with status 'error'). */
function recordRun(id, { at, jobId, status }) {
  getDb().prepare('UPDATE schedules SET last_run_at = ?, last_job_id = ?, last_status = ? WHERE id = ?')
    .run(at, jobId ?? null, status, id)
}

/** Record the final status of the schedule's latest job (ignored for older jobs). */
function recordJobFinished(id, jobId, status) {
  getDb().prepare('UPDATE schedules SET last_status = ? WHERE id = ? AND last_job_id = ?').run(status, id, jobId)
}

/**
 * Last successful scheduled backup per schedule id.
 * @returns {Map<string, number>} scheduleId → finished_at (ms)
 */
function lastSuccessBySchedule() {
  const rows = getDb().prepare(`
    SELECT json_extract(meta, '$.scheduleId') AS schedule_id, MAX(finished_at) AS at
    FROM jobs
    WHERE status = 'success' AND json_extract(meta, '$.scheduleId') IS NOT NULL
    GROUP BY schedule_id
  `).all()
  return new Map(rows.map((r) => [r.schedule_id, r.at]))
}

module.exports = {
  migrateSchedules, listSchedules, getSchedule, dueSchedules, insertSchedule, updateSchedule,
  deleteSchedule, setNextRun, recordRun, recordJobFinished, lastSuccessBySchedule,
}
