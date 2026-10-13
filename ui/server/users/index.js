const express = require('express')
const store = require('./store')
const { purgeExpiredSessions } = require('./sessions')
const authRoutes = require('./auth-routes')
const adminRoutes = require('./admin-routes')

// Users & sessions feature module (see modules.js). The authentication
// middleware itself lives in ../auth.js and bootstraps the first admin.

const PURGE_INTERVAL_MS = 60 * 60 * 1000

function init() {
  store.initSchema()
  purgeExpiredSessions()
  setInterval(purgeExpiredSessions, PURGE_INTERVAL_MS).unref()
}

const router = express.Router()
router.use(authRoutes.router)
router.use(adminRoutes.router)

module.exports = { init, router, publicRouter: authRoutes.publicRouter }
