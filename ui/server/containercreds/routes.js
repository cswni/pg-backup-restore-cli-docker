const express = require('express')
const { requireAdmin } = require('../auth')
const { requireServer } = require('../servers')
const { getDriver } = require('../drivers')
const { httpError, isValidContainerName } = require('../validation')
const { handle } = require('../routes/util')
const store = require('./store')
const { validateCredentialsInput } = require('./validate')

// Container credentials API (admin only)
//   GET    /api/servers/:id/container-credentials
//   PUT    /api/servers/:id/container-credentials/:key        blank password keeps, null clears
//   DELETE /api/servers/:id/container-credentials/:key
//   POST   /api/servers/:id/container-credentials/:key/test   { container } -> { ok, databases?, error? }
// :key is a container name or a Swarm service name; a task container name is
// stored under its service name. Passwords never leave the server.

const MAX_ERROR_LENGTH = 2000

const router = express.Router()

function dockerServer(id) {
  const server = requireServer(id)
  if (server.kind !== 'docker') throw httpError(400, `${server.name} is not a Docker server: container credentials apply to Docker servers only`)
  return server
}

function keyParam(value) {
  if (!isValidContainerName(value)) throw httpError(400, `Invalid container name: ${value}`)
  return store.credentialKey(value)
}

function savedOr404(server, key) {
  const saved = store.getCredentials(server.id, key)
  if (!saved) throw httpError(404, `No saved credentials for ${key} on ${server.name}`)
  return saved
}

router.get('/servers/:id/container-credentials', requireAdmin, handle(async (req, res) => {
  const server = dockerServer(req.params.id)
  res.json(store.listCredentials(server.id).map(store.toPublic))
}))

router.put('/servers/:id/container-credentials/:key', requireAdmin, handle(async (req, res) => {
  const server = dockerServer(req.params.id)
  const key = keyParam(req.params.key)
  const record = validateCredentialsInput(req.body, store.getCredentials(server.id, key))
  res.json(store.toPublic(store.saveCredentials(server.id, key, record)))
}))

router.delete('/servers/:id/container-credentials/:key', requireAdmin, handle(async (req, res) => {
  const server = dockerServer(req.params.id)
  const key = keyParam(req.params.key)
  savedOr404(server, key)
  store.deleteCredentials(server.id, key)
  res.json({ ok: true })
}))

router.post('/servers/:id/container-credentials/:key/test', requireAdmin, handle(async (req, res) => {
  const server = dockerServer(req.params.id)
  const key = keyParam(req.params.key)
  const container = req.body?.container
  if (!container) throw httpError(400, 'Choose a running container to test with')
  if (!isValidContainerName(container)) throw httpError(400, `Invalid container name: ${container}`)
  if (store.credentialKey(container) !== key) throw httpError(400, `Container ${container} does not use the credentials saved as ${key}`)
  const saved = savedOr404(server, key)
  try {
    const databases = await getDriver(saved.engine, 'docker').listDatabases({ server, container })
    res.json({ ok: true, databases: databases.length })
  } catch (err) {
    res.json({ ok: false, error: String(err.message || err).trim().slice(0, MAX_ERROR_LENGTH) })
  }
}))

module.exports = { router }
