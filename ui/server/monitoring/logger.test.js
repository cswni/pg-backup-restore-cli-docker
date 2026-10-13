const { test, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const { createLogger } = require('./logger')

const saved = { LOG_LEVEL: process.env.LOG_LEVEL, LOG_FORMAT: process.env.LOG_FORMAT }

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

function capture() {
  const out = []
  return { out, logger: createLogger('test', { write: (line, level) => out.push({ line, level }) }) }
}

test('human format includes level, component, message and fields', () => {
  delete process.env.LOG_FORMAT
  process.env.LOG_LEVEL = 'info'
  const { out, logger } = capture()
  logger.info('Started backup', { jobId: 'j1', note: 'two words' })
  assert.equal(out.length, 1)
  assert.match(out[0].line, /^\d{4}-\d{2}-\d{2}T.*Z INFO  \[test\] Started backup jobId=j1 note="two words"$/)
})

test('json format emits one parseable object per line', () => {
  process.env.LOG_FORMAT = 'json'
  const { out, logger } = capture()
  logger.error('Boom', { error: new Error('bad thing'), count: 2 })
  const rec = JSON.parse(out[0].line)
  assert.equal(rec.level, 'error')
  assert.equal(rec.component, 'test')
  assert.equal(rec.msg, 'Boom')
  assert.equal(rec.error, 'bad thing')
  assert.equal(rec.count, 2)
  assert.equal(out[0].level, 'error')
})

test('LOG_LEVEL filters lower levels', () => {
  process.env.LOG_LEVEL = 'warn'
  const { out, logger } = capture()
  logger.debug('d')
  logger.info('i')
  logger.warn('w')
  logger.error('e')
  assert.deepEqual(out.map((o) => o.level), ['warn', 'error'])
})

test('unknown LOG_LEVEL falls back to info', () => {
  process.env.LOG_LEVEL = 'verbose'
  const { out, logger } = capture()
  logger.debug('hidden')
  logger.info('shown')
  assert.equal(out.length, 1)
})
