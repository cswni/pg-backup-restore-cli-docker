const fs = require('fs')
const path = require('path')
const express = require('express')
const { DIST_DIR } = require('./config')
const { setupAuth } = require('./auth')

/** Baseline browser hardening for the SPA and API (no inline scripts are used). */
function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('X-Frame-Options', 'DENY')
  res.setHeader('Referrer-Policy', 'same-origin')
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "img-src 'self' data:",
    "style-src 'self' 'unsafe-inline'", // React style attributes
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ].join('; '))
  next()
}

/**
 * Build the Express app. Exported separately from index.js so tests can
 * start it on an ephemeral port.
 */
function createApp() {
  const modules = require('./modules')
  for (const m of modules) if (typeof m.init === 'function') m.init()

  const app = express()
  // Trust X-Forwarded-* only from private/loopback hops (Traefik on the
  // Docker network) so clients can't spoof their IP for rate limiting.
  // TRUST_PROXY accepts any Express "trust proxy" value (hop count, CIDRs).
  app.set('trust proxy', process.env.TRUST_PROXY || 'loopback, linklocal, uniquelocal')
  app.disable('x-powered-by')
  app.use(securityHeaders)
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
    // dotfiles: 'allow', because the fixed index path may itself sit under a dot-directory
    app.get('/{*splat}', (req, res) => res.sendFile(path.join(DIST_DIR, 'index.html'), { dotfiles: 'allow' }))
  }

  return app
}

module.exports = { createApp }
