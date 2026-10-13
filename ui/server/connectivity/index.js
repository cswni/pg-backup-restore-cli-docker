const servers = require('../servers')
const { syncSshConfig } = require('./ssh-config')
const { router } = require('./routes')

// Connectivity module: server registry (remote Docker hosts over SSH, direct
// database connections with optional SSH tunnels) and its API.

function init() {
  servers.init()
  try {
    syncSshConfig()
  } catch (err) {
    // Not fatal: it is regenerated before every SSH use
    console.warn(`[pg-backup-ui] Could not write the managed SSH config: ${err.message}`)
  }
}

module.exports = { init, router }
