const { setupTestEnv, startTestServer } = require('../test-helpers')
setupTestEnv({ SCHEDULER_ENABLED: 'false', LOG_LEVEL: 'error', JOB_LOG_RETENTION_DAYS: '7' })

const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const { randomUUID } = require('crypto')
const jobs = require('../jobs')
const { getDb } = require('../db')
const { readJobLog, appendLine, sweepOldLogs, LOGS_DIR } = require('./joblogs')

const DAY = 24 * 60 * 60 * 1000
let srv

before(async () => { srv = await startTestServer() })
after(async () => { await srv.close() })

function runJob(work) {
  return new Promise((resolve) => {
    const id = jobs.startJob('test', { database: 'app' }, work)
    const on = (s) => {
      if (s.id !== id) return
      jobs.events.removeListener('finished', on)
      resolve(id)
    }
    jobs.events.on('finished', on)
  })
}

/** A finished job that is no longer in memory (as after a restart or the 10 min window). */
function historicJob(lines) {
  const id = randomUUID()
  getDb().prepare("INSERT INTO jobs (id, type, status, meta, started_at, finished_at, exit_code) VALUES (?, 'export', 'success', '{}', ?, ?, 0)")
    .run(id, Date.now() - 1000, Date.now())
  lines.forEach((l) => appendLine(id, l))
  return id
}

test('log lines are persisted as JSON lines while the job runs, including the final line', async () => {
  const id = await runJob(async (job) => { job.log('line one\nline two'); job.log('oops', 'stderr') })
  const lines = readJobLog(id)
  assert.deepEqual(lines.map((l) => [l.type, l.text]), [
    ['stdout', 'line one'], ['stdout', 'line two'], ['stderr', 'oops'], ['done', 'Process exited with code 0'],
  ])
  assert.ok(lines.every((l) => typeof l.ts === 'number'))
  assert.ok(fs.existsSync(path.join(LOGS_DIR, `${id}.log`)))
})

test('getJob and GET /api/jobs/:id return persisted lines for jobs no longer in memory', async () => {
  const id = historicJob([{ type: 'stdout', text: 'old output', ts: 1 }, { type: 'done', text: 'Process exited with code 0', ts: 2 }])
  assert.equal(jobs.getLiveJob(id), null)
  assert.equal(jobs.getJob(id).lines[0].text, 'old output')
  const res = await srv.request('GET', `/api/jobs/${id}`)
  assert.equal(res.status, 200)
  assert.equal(res.json.lines.length, 2)
})

test('the SSE stream replays persisted lines for finished jobs', async () => {
  const id = historicJob([{ type: 'stdout', text: 'from disk', ts: 1 }])
  const res = await srv.request('GET', `/api/jobs/${id}/stream`)
  assert.equal(res.status, 200)
  assert.match(res.text, /event: log\ndata: \{"type":"stdout","text":"from disk","ts":1\}/)
  assert.match(res.text, /event: done\ndata: \{"exitCode":0\}/)
})

test('jobs without a stored log return no lines', () => {
  const id = historicJob([])
  assert.deepEqual(jobs.getJob(id).lines, [])
})

test('rejects non-UUID job ids (no path traversal)', () => {
  appendLine('../../evil', { type: 'stdout', text: 'x', ts: 1 })
  assert.deepEqual(readJobLog('../../evil'), [])
  assert.equal(fs.existsSync(path.join(LOGS_DIR, '..', '..', 'evil.log')), false)
})

test('corrupt lines are skipped', () => {
  const id = historicJob([{ type: 'stdout', text: 'good', ts: 1 }])
  fs.appendFileSync(path.join(LOGS_DIR, `${id}.log`), '{not json\n')
  assert.deepEqual(readJobLog(id).map((l) => l.text), ['good'])
})

test('sweep deletes logs older than JOB_LOG_RETENTION_DAYS and keeps recent ones', () => {
  const oldId = historicJob([{ type: 'stdout', text: 'old', ts: 1 }])
  const newId = historicJob([{ type: 'stdout', text: 'new', ts: 1 }])
  const oldTime = new Date(Date.now() - 8 * DAY)
  fs.utimesSync(path.join(LOGS_DIR, `${oldId}.log`), oldTime, oldTime)
  const removed = sweepOldLogs()
  assert.ok(removed >= 1)
  assert.deepEqual(readJobLog(oldId), [])
  assert.equal(readJobLog(newId)[0].text, 'new')
})
