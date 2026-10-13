const { getDb } = require('../db')
const catalog = require('../catalog')
const scheduler = require('../scheduler')

// Prometheus text exposition (format 0.0.4), computed from the jobs table,
// schedules and the backup catalog on every scrape.

const PREFIX = 'pgbackup'
const DURATION_BUCKETS = [1, 5, 15, 30, 60, 300, 900, 1800, 3600, 7200]

function escapeLabel(v) {
  return String(v ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')
}

function labelString(labels = {}) {
  const parts = Object.entries(labels).map(([k, v]) => `${k}="${escapeLabel(v)}"`)
  return parts.length ? `{${parts.join(',')}}` : ''
}

/**
 * Render one metric family.
 * @param {string} name  without prefix
 * @param {string} type  counter | gauge | histogram
 * @param {string} help
 * @param {Array<{ labels?: object, value: number, suffix?: string }>} samples
 */
function family(name, type, help, samples) {
  const full = `${PREFIX}_${name}`
  return [
    `# HELP ${full} ${help}`,
    `# TYPE ${full} ${type}`,
    ...samples.map((s) => `${full}${s.suffix || ''}${labelString(s.labels)} ${Number.isFinite(s.value) ? s.value : 0}`),
  ]
}

const seconds = (ms) => (ms == null ? 0 : Math.round(ms / 1000))

function jobCountSamples(db) {
  return db.prepare('SELECT type, status, COUNT(*) AS n FROM jobs GROUP BY type, status ORDER BY type, status').all()
    .map((r) => ({ labels: { type: r.type, status: r.status }, value: r.n }))
}

function durationSamples(db) {
  const rows = db.prepare(
    "SELECT type, (finished_at - started_at) / 1000.0 AS d FROM jobs WHERE finished_at IS NOT NULL AND status != 'running'"
  ).all()
  const byType = new Map()
  for (const r of rows) byType.set(r.type, [...(byType.get(r.type) || []), Math.max(0, r.d)])
  return [...byType.entries()].sort(([a], [b]) => a.localeCompare(b)).flatMap(([type, ds]) => [
    ...DURATION_BUCKETS.map((le) => ({ suffix: '_bucket', labels: { type, le }, value: ds.filter((d) => d <= le).length })),
    { suffix: '_bucket', labels: { type, le: '+Inf' }, value: ds.length },
    { suffix: '_sum', labels: { type }, value: Math.round(ds.reduce((a, b) => a + b, 0) * 1000) / 1000 },
    { suffix: '_count', labels: { type }, value: ds.length },
  ])
}

function lastBackupSamples(db) {
  return db.prepare(`
    SELECT json_extract(meta, '$.serverId') AS server, json_extract(meta, '$.database') AS database,
           MAX(finished_at) AS at
    FROM jobs WHERE type = 'export' AND status = 'success'
    GROUP BY server, database ORDER BY server, database
  `).all().map((r) => ({ labels: { server: r.server || 'local', database: r.database }, value: seconds(r.at) }))
}

function scheduleFamilies(now) {
  const states = scheduler.scheduleStates(now)
  const labels = (s) => ({ schedule_id: s.id, schedule: s.name })
  return [
    ...family('schedule_enabled', 'gauge', 'Whether the schedule is enabled (1) or disabled (0).',
      states.map((s) => ({ labels: labels(s), value: s.enabled ? 1 : 0 }))),
    ...family('schedule_last_success_timestamp_seconds', 'gauge', 'Unix time of the last successful run of the schedule (0 = never).',
      states.map((s) => ({ labels: labels(s), value: seconds(s.lastSuccessAt) }))),
    ...family('schedule_next_run_timestamp_seconds', 'gauge', 'Unix time of the next planned run (0 = none).',
      states.map((s) => ({ labels: labels(s), value: seconds(s.nextRunAt) }))),
    ...family('schedule_overdue', 'gauge', '1 when the schedule missed its run or has no success within 2x its interval.',
      states.map((s) => ({ labels: labels(s), value: s.overdue ? 1 : 0 }))),
  ]
}

function catalogFamilies() {
  const files = catalog.listBackups()
  return [
    ...family('backup_files', 'gauge', 'Number of backup files in the backups directory.', [{ value: files.length }]),
    ...family('backup_bytes', 'gauge', 'Total size of backup files in bytes.', [{ value: files.reduce((a, f) => a + (f.size || 0), 0) }]),
  ]
}

/**
 * Render all metrics.
 * @param {number} [now]
 * @returns {string} Prometheus text format
 */
function renderMetrics(now = Date.now()) {
  const db = getDb()
  const running = db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status = 'running'").get().n
  return [
    ...family('up', 'gauge', 'The pg-backup UI is running.', [{ value: 1 }]),
    ...family('process_uptime_seconds', 'gauge', 'Seconds since the server process started.', [{ value: Math.round(process.uptime()) }]),
    ...family('jobs_total', 'counter', 'Jobs recorded, by type and final status.', jobCountSamples(db)),
    ...family('jobs_running', 'gauge', 'Jobs currently running.', [{ value: running }]),
    ...family('job_duration_seconds', 'histogram', 'Duration of finished jobs.', durationSamples(db)),
    ...family('last_successful_backup_timestamp_seconds', 'gauge', 'Unix time of the last successful backup per server and database.', lastBackupSamples(db)),
    ...scheduleFamilies(now),
    ...catalogFamilies(),
  ].join('\n') + '\n'
}

module.exports = { renderMetrics, escapeLabel }
