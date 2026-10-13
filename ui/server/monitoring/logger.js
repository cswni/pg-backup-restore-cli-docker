// Tiny structured logger.
//   LOG_LEVEL  = debug | info | warn | error   (default info)
//   LOG_FORMAT = json → one JSON object per line; anything else → human-readable
// Environment is read on every call so tests can change it without
// re-requiring modules.

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 }

function currentLevel() {
  return LEVELS[String(process.env.LOG_LEVEL || 'info').toLowerCase()] ?? LEVELS.info
}

function isJson() {
  return String(process.env.LOG_FORMAT || '').toLowerCase() === 'json'
}

function formatValue(v) {
  if (v instanceof Error) return v.message
  if (typeof v === 'string') return /\s/.test(v) ? JSON.stringify(v) : v
  return JSON.stringify(v)
}

/**
 * Render one log record as a single line (no trailing newline).
 * @param {{ ts: string, level: string, component: string, msg: string }} record  plus extra fields
 * @param {boolean} json
 * @returns {string}
 */
function formatRecord(record, json) {
  if (json) return JSON.stringify(record, (k, v) => (v instanceof Error ? v.message : v))
  const { ts, level, component, msg, ...fields } = record
  const extra = Object.entries(fields).map(([k, v]) => `${k}=${formatValue(v)}`).join(' ')
  return `${ts} ${level.toUpperCase().padEnd(5)} [${component}] ${msg}${extra ? ' ' + extra : ''}`
}

function defaultWrite(line, level) {
  const stream = level === 'error' || level === 'warn' ? process.stderr : process.stdout
  stream.write(line + '\n')
}

/**
 * Create a logger for a component.
 * @param {string} component  e.g. 'scheduler'
 * @param {{ write?: (line: string, level: string) => void }} [opts]  custom sink (tests)
 * @returns {{ debug: Function, info: Function, warn: Function, error: Function }}
 */
function createLogger(component, opts = {}) {
  const write = opts.write || defaultWrite
  const log = (level) => (msg, fields = {}) => {
    if (LEVELS[level] < currentLevel()) return
    const record = { ts: new Date().toISOString(), level, component, msg, ...fields }
    write(formatRecord(record, isJson()), level)
  }
  return { debug: log('debug'), info: log('info'), warn: log('warn'), error: log('error') }
}

module.exports = { createLogger, formatRecord, LEVELS }
