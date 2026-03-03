const express = require('express')
const path = require('path')
const fs = require('fs')
const { listContainers, listDatabases } = require('./docker')
const { runOperation, getJob, listJobs } = require('./operations')

const app = express()
const PORT = process.env.PORT || 3000
const BACKUPS_DIR = process.env.BACKUPS_DIR || '/backups'

app.use(express.json())

// ── Serve built frontend ─────────────────────────────────────────────────────
const DIST = path.join(__dirname, '..', 'dist')
if (fs.existsSync(DIST)) {
  app.use(express.static(DIST))
}

// ── Containers ───────────────────────────────────────────────────────────────
app.get('/api/containers', async (req, res) => {
  try {
    res.json(await listContainers())
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.get('/api/containers/:name/databases', async (req, res) => {
  try {
    const dbs = await listDatabases(req.params.name)
    res.json(dbs)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── Backups ───────────────────────────────────────────────────────────────────
app.get('/api/backups', (req, res) => {
  try {
    if (!fs.existsSync(BACKUPS_DIR)) return res.json([])
    const files = fs.readdirSync(BACKUPS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .map((f) => {
        const stat = fs.statSync(path.join(BACKUPS_DIR, f))
        return { name: f, size: stat.size, mtime: stat.mtimeMs }
      })
      .sort((a, b) => b.mtime - a.mtime)
    res.json(files)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.get('/api/backups/:filename/download', (req, res) => {
  const file = path.join(BACKUPS_DIR, path.basename(req.params.filename))
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'Not found' })
  res.download(file)
})

app.delete('/api/backups/:filename', (req, res) => {
  const file = path.join(BACKUPS_DIR, path.basename(req.params.filename))
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'Not found' })
  fs.unlinkSync(file)
  res.json({ ok: true })
})

// ── Operations ────────────────────────────────────────────────────────────────
const OPS = ['export', 'create', 'delete', 'unblock', 'restore']

OPS.forEach((op) => {
  app.post(`/api/ops/${op}`, (req, res) => {
    const { container, database, file } = req.body
    if (!container || !database) {
      return res.status(400).json({ error: 'container and database are required' })
    }
    try {
      const jobId = runOperation(op, { container, database, file })
      res.json({ jobId })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })
})

// List recent jobs
app.get('/api/jobs', (req, res) => res.json(listJobs()))

// SSE stream for a job
app.get('/api/jobs/:jobId/stream', (req, res) => {
  const job = getJob(req.params.jobId)
  if (!job) return res.status(404).json({ error: 'Job not found' })

  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()

  const send = (line) => {
    res.write(`event: log\ndata: ${JSON.stringify(line)}\n\n`)
  }

  // Replay buffered lines first
  job.lines.forEach(send)

  if (job.status !== 'running') {
    res.write(`event: done\ndata: ${JSON.stringify({ exitCode: job.exitCode })}\n\n`)
    return res.end()
  }

  job.emitter.on('line', send)
  job.emitter.once('done', (code) => {
    res.write(`event: done\ndata: ${JSON.stringify({ exitCode: code })}\n\n`)
    res.end()
  })

  req.on('close', () => {
    job.emitter.removeListener('line', send)
  })
})

// ── Job status ────────────────────────────────────────────────────────────────
app.get('/api/jobs/:jobId', (req, res) => {
  const job = getJob(req.params.jobId)
  if (!job) return res.status(404).json({ error: 'Not found' })
  res.json({
    status: job.status,
    exitCode: job.exitCode,
    operation: job.operation,
    container: job.container,
    database: job.database,
    lines: job.lines,
  })
})

// ── SPA fallback ──────────────────────────────────────────────────────────────
if (fs.existsSync(DIST)) {
  app.get('*', (req, res) => {
    res.sendFile(path.join(DIST, 'index.html'))
  })
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[pg-backup-ui] Web UI running at http://0.0.0.0:${PORT}`)
})

