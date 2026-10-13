const fs = require('fs')
const path = require('path')
const express = require('express')
const { DIST_DIR } = require('./config')
const { setupAuth } = require('./auth')

/**
 * Build the Express app. Exported separately from index.js so tests can
 * start it on an ephemeral port.
 */
function createApp() {
  const modules = require('./modules')
  for (const m of modules) if (typeof m.init === 'function') m.init()

  const app = express()
  app.set('trust proxy', true) // behind Traefik/Cloudflare: honour X-Forwarded-Proto for secure cookies
  app.use(express.json({ limit: '1mb' }))

  // Routes reachable without authentication (login, health, OAuth callbacks)
  for (const m of modules) if (m.publicRouter) app.use('/api', m.publicRouter)

  setupAuth(app)

  for (const m of modules) if (m.router) app.use('/api', m.router)

  // Unknown API routes are JSON 404s, never the SPA
  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }))

  // Built frontend + SPA fallback
  if (fs.existsSync(DIST_DIR)) {
    app.use(express.static(DIST_DIR))
    app.get('/{*splat}', (req, res) => res.sendFile(path.join(DIST_DIR, 'index.html')))
  }

  return app
}

module.exports = { createApp }
