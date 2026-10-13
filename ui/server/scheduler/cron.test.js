const { test } = require('node:test')
const assert = require('node:assert/strict')
const { cronError, nextRuns, nextRunAt, intervalMs, isValidTimezone, defaultTimezone } = require('./cron')

const FROM = Date.parse('2026-10-12T10:30:00Z')

test('accepts standard 5-field expressions and nicknames', () => {
  for (const expr of ['0 2 * * *', '*/15 * * * *', '30 3 * * 1-5', '0 0 1 * *', '@daily', '@hourly']) {
    assert.equal(cronError(expr, 'UTC'), null, expr)
  }
})

test('rejects malformed, out-of-range, 6-field and never-matching expressions', () => {
  assert.match(cronError('', 'UTC'), /required/)
  assert.match(cronError('* * * * * *', 'UTC'), /5 fields/)
  assert.match(cronError('0 2 * *', 'UTC'), /5 fields/)
  assert.match(cronError('61 * * * *', 'UTC'), /Invalid cron expression/)
  assert.match(cronError('0 0 31 2 *', 'UTC'), /never matches/)
  assert.match(cronError('x'.repeat(200), 'UTC'), /too long/)
  assert.match(cronError(42, 'UTC'), /required/)
})

test('validates IANA timezones', () => {
  assert.equal(isValidTimezone('Europe/Madrid'), true)
  assert.equal(isValidTimezone('Not/AZone'), false)
  assert.equal(isValidTimezone(''), false)
  assert.match(cronError('0 2 * * *', 'Not/AZone'), /Unknown timezone/)
})

test('defaultTimezone uses a valid TZ env or falls back to UTC', () => {
  const old = process.env.TZ
  try {
    process.env.TZ = 'Nope/Zone'
    assert.equal(defaultTimezone(), 'UTC')
    process.env.TZ = 'America/New_York'
    assert.equal(defaultTimezone(), 'America/New_York')
  } finally {
    if (old === undefined) delete process.env.TZ
    else process.env.TZ = old
  }
})

test('computes next runs in the schedule timezone', () => {
  const runs = nextRuns('0 2 * * *', 'Europe/Madrid', FROM, 3).map((ms) => new Date(ms).toISOString())
  // 02:00 in Madrid (CEST, UTC+2) is 00:00 UTC
  assert.deepEqual(runs, ['2026-10-13T00:00:00.000Z', '2026-10-14T00:00:00.000Z', '2026-10-15T00:00:00.000Z'])
  assert.equal(new Date(nextRunAt('0 * * * *', 'UTC', FROM)).toISOString(), '2026-10-12T11:00:00.000Z')
})

test('next run is strictly after the reference time', () => {
  const at = Date.parse('2026-10-12T11:00:00Z')
  assert.equal(new Date(nextRunAt('0 * * * *', 'UTC', at)).toISOString(), '2026-10-12T12:00:00.000Z')
})

test('interval is the gap between the next two runs', () => {
  assert.equal(intervalMs('0 * * * *', 'UTC', FROM), 3600000)
  assert.equal(intervalMs('0 2 * * *', 'UTC', FROM), 86400000)
})
