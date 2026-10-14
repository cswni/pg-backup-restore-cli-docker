const express = require('express')
const servers = require('../servers')
const { requireAdmin } = require('../auth')
const { getDriver, listEngines } = require('../drivers')
const { httpError } = require('../validation')
const { handle } = require('../routes/util')
const { validateServerInput, endpointChanged } = require('./validate')
const { syncSshConfig, hostKeys, forgetHostKey } = require('./ssh-config')
const { testServer } = require('./test-connection')

// Servers API
//   GET    /api/servers                  all roles, secrets masked
//   GET    /api/servers/:id              all roles
//   GET    /api/servers/:id/databases    all roles, direct servers only
//   POST   /api/servers                  admin
//   PUT    /api/servers/:id              admin (empty secret fields keep the stored value)
//   DELETE /api/servers/:id              admin (backups made from it are kept)
//   POST   /api/servers/:id/test         admin
//   DELETE /api/servers/:id/host-key     admin (forget the trusted SSH host key)

const router = express.Router()

/** Browser-safe server with its trusted host key fingerprints. */
function publicView(server) {
  if (server.builtin) return servers.toPublic(server)
  return servers.toPublic(server, { hostKeys: hostKeys(server.id) })
}

function directEngines() {
  return listEngines().filter((e) => e.kinds.includes('direct')).map((e) => e.engine)
}

/** A stored (non built-in) server, or 404/400. */
function editableServer(id) {
  const server = servers.requireServer(id)
  if (server.builtin) throw httpError(400, 'The built-in local server cannot be modified')
  return server
}

router.get('/servers', handle(async (req, res) => {
  res.json(servers.listServers().map(publicView))
}))

router.get('/servers/:id', handle(async (req, res) => {
  res.json(publicView(servers.requireServer(req.params.id)))
}))

router.get('/servers/:id/databases', handle(async (req, res) => {
  const server = servers.requireServer(req.params.id)
  if (server.kind !== 'direct') throw httpError(400, `${server.name} is a Docker server: list databases per container`)
  res.json(await getDriver(server.engine, server.kind).listDatabases({ server }))
}))

router.post('/servers', requireAdmin, handle(async (req, res) => {
  const record = validateServerInput(req.body, null, directEngines())
  const server = servers.createServer(record)
  syncSshConfig()
  res.status(201).json(publicView(server))
}))

router.put('/servers/:id', requireAdmin, handle(async (req, res) => {
  const existing = editableServer(req.params.id)
  const record = validateServerInput(req.body, existing, directEngines())
  const server = servers.updateServer(existing.id, record)
  if (endpointChanged(existing, server)) forgetHostKey(server.id)
  syncSshConfig()
  res.json(publicView(server))
}))

router.delete('/servers/:id', requireAdmin, handle(async (req, res) => {
  const server = editableServer(req.params.id)
  servers.deleteServer(server.id)
  forgetHostKey(server.id)
  syncSshConfig()
  res.json({ ok: true })
}))

router.post('/servers/:id/test', requireAdmin, handle(async (req, res) => {
  res.json(await testServer(servers.requireServer(req.params.id)))
}))

router.delete('/servers/:id/host-key', requireAdmin, handle(async (req, res) => {
  const server = editableServer(req.params.id)
  res.json({ ok: true, removed: forgetHostKey(server.id) })
}))

module.exports = { router, publicView }
