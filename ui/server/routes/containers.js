const express = require('express')
const { listServers, requireServer, execEnv } = require('../servers')
const { listContainers } = require('../docker')
const { getDriver, listEngines } = require('../drivers')
const { httpError } = require('../validation')
const { handle } = require('./util')

const router = express.Router()

/** Strip secrets before sending servers to the browser. */
function publicServer(s) {
  const { password, sshPrivateKey, sshPassword, ...rest } = s
  return rest
}

router.get('/servers', handle(async (req, res) => {
  res.json(listServers().map(publicServer))
}))

router.get('/engines', handle(async (req, res) => {
  res.json(listEngines())
}))

// Containers on a Docker server (default: local)
router.get('/containers', handle(async (req, res) => {
  const server = requireServer(req.query.serverId || 'local')
  if (server.kind !== 'docker') throw httpError(400, `${server.name} is not a Docker server`)
  res.json(await listContainers(await execEnv(server)))
}))

router.get('/containers/:name/databases', handle(async (req, res) => {
  const server = requireServer(req.query.serverId || 'local')
  const driver = getDriver(req.query.engine || 'postgres', server.kind)
  res.json(await driver.listDatabases({ server, container: req.params.name }))
}))

module.exports = { router, publicServer }
