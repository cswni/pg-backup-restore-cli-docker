const { Cron } = require('croner')

// Cron helpers on top of croner (standard 5-field expressions plus the
// @hourly/@daily/@weekly/@monthly/@yearly nicknames), always evaluated in an
// IANA timezone so DST is handled by croner.

const NICKNAMES = ['@yearly', '@annually', '@monthly', '@weekly', '@daily', '@midnight', '@hourly']
const MAX_CRON_LENGTH = 100

/** Default timezone for new schedules: TZ env (when valid) or UTC. */
function defaultTimezone() {
  const tz = process.env.TZ
  return tz && isValidTimezone(tz) ? tz : 'UTC'
}

/**
 * True for IANA timezone names supported by this Node runtime.
 * @param {string} tz
 * @returns {boolean}
 */
function isValidTimezone(tz) {
  if (typeof tz !== 'string' || !tz || tz.length > 64) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

function buildCron(expr, tz) {
  return new Cron(expr, { mode: '5-part', timezone: tz, paused: true })
}

/**
 * Validate a cron expression in a timezone.
 * @param {string} expr
 * @param {string} tz
 * @returns {string|null} error message, or null when valid
 */
function cronError(expr, tz) {
  if (typeof expr !== 'string' || !expr.trim()) return 'Cron expression is required'
  const trimmed = expr.trim()
  if (trimmed.length > MAX_CRON_LENGTH) return 'cron expression is too long'
  const isNickname = NICKNAMES.includes(trimmed.toLowerCase())
  if (!isNickname && trimmed.split(/\s+/).length !== 5) {
    return 'cron expression must have 5 fields: minute hour day-of-month month day-of-week'
  }
  if (!isValidTimezone(tz)) return `Unknown timezone: ${tz}`
  try {
    if (!buildCron(trimmed, tz).nextRun()) return 'cron expression never matches a future date'
  } catch (err) {
    return `Invalid cron expression: ${err.message.replace(/^CronPattern:\s*/, '')}`
  }
  return null
}

/**
 * Next `count` run times strictly after `from`.
 * @param {string} expr  valid cron expression
 * @param {string} tz
 * @param {number} from  epoch ms
 * @param {number} [count]
 * @returns {number[]} epoch ms
 */
function nextRuns(expr, tz, from, count = 5) {
  return buildCron(expr.trim(), tz).nextRuns(count, new Date(from)).map((d) => d.getTime())
}

/**
 * Next run strictly after `from`, or null when the expression never matches again.
 * @returns {number|null}
 */
function nextRunAt(expr, tz, from) {
  const d = buildCron(expr.trim(), tz).nextRun(new Date(from))
  return d ? d.getTime() : null
}

/**
 * Nominal interval of a schedule: gap between its next two runs after `from`.
 * @returns {number|null} ms
 */
function intervalMs(expr, tz, from) {
  const [a, b] = nextRuns(expr, tz, from, 2)
  return a && b ? b - a : null
}

module.exports = { defaultTimezone, isValidTimezone, cronError, nextRuns, nextRunAt, intervalMs }
