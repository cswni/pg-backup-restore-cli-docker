const express = require('express')
const { getJob, getLiveJob, listJobs } = require('../jobs')
const { httpError } = require('../validation')
const { handle } = require('./util')

const router = express.Router()

// GET /api/jobs?limit=&offset=&type=&status=
router.get('/jobs', handle(async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 500)
  const offset = Number(req.query.offset) || 0
  res.json(listJobs({ limit, offset, type: req.query.type, status: req.query.status }))
}))

// SSE stream of a job's log
router.get('/jobs/:jobId/stream', (req, res) => {
  const job = getLiveJob(req.params.jobId)
  const summary = job ? null : getJob(req.params.jobId)
  if (!job && !summary) return res.status(404).json({ error: 'Job not found' })

  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')
  res.flushHeaders()

  const send = (line) => res.write(`event: log\ndata: ${JSON.stringify(line)}\n\n`)
  const done = (code) => {
    res.write(`event: done\ndata: ${JSON.stringify({ exitCode: code })}\n\n`)
    res.end()
  }

  // Finished jobs no longer in memory: only the final status is known
  if (!job) return done(summary.exitCode)

  job.lines.forEach(send)
  if (job.status !== 'running') return done(job.exitCode)

  job.emitter.on('line', send)
  job.emitter.once('done', done)
  req.on('close', () => {
    job.emitter.removeListener('line', send)
    job.emitter.removeListener('done', done)
  })
})

router.get('/jobs/:jobId', handle(async (req, res) => {
  const job = getJob(req.params.jobId)
  if (!job) throw httpError(404, 'Not found')
  res.json(job)
}))

module.exports = { router }
