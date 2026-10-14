const express = require('express')
const { requireServer, execEnv, toPublic } = require('../servers')
const { listContainers } = require('../docker')
const { getDriver, listEngines } = require('../drivers')
const { httpError, isValidContainerName } = require('../validation')
const { handle } = require('./util')
const { credentialKey, listCredentials } = require('../containercreds/store')

const router = express.Router()

/** Strip secrets before sending servers to the browser. */
function publicServer(s) {
  return toPublic(s)
}

function requireDockerServer(id) {
  const server = requireServer(id || 'local')
  if (server.kind !== 'docker') throw httpError(400, `${server.name} is not a Docker server`)
  return server
}

router.get('/engines', handle(async (req, res) => {
  res.json(listEngines())
}))

// Containers on a Docker server (default: local)
router.get('/containers', handle(async (req, res) => {
  const server = requireDockerServer(req.query.serverId)
  const containers = await listContainers(await execEnv(server))
  const savedEngines = new Map(listCredentials(server.id).map((c) => [c.key, c.engine]))
  res.json(containers.map((c) => {
    const key = credentialKey(c.name)
    return { ...c, credentialKey: key, credentialsConfigured: savedEngines.get(key) === c.engine }
  }))
}))

router.get('/containers/:name/databases', handle(async (req, res) => {
  if (!isValidContainerName(req.params.name)) throw httpError(400, `Invalid container name: ${req.params.name}`)
  const server = requireDockerServer(req.query.serverId)
  const driver = getDriver(req.query.engine || 'postgres', server.kind)
  res.json(await driver.listDatabases({ server, container: req.params.name }))
}))

module.exports = { router, publicServer }
