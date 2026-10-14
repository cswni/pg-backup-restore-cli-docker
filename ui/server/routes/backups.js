const fs = require('fs')
const express = require('express')
const { listBackups, backupPath, removeCatalogEntry } = require('../catalog')
const { requireAdmin } = require('../auth')
const { httpError } = require('../validation')
const { handle } = require('./util')

const router = express.Router()

router.get('/backups', handle(async (req, res) => {
  res.json(listBackups())
}))

router.get('/backups/:filename/download', handle(async (req, res) => {
  const file = backupPath(req.params.filename)
  if (!fs.existsSync(file)) throw httpError(404, `Backup file not found: ${req.params.filename}`)
  res.download(file)
}))

router.delete('/backups/:filename', requireAdmin, handle(async (req, res) => {
  const file = backupPath(req.params.filename)
  if (!fs.existsSync(file)) throw httpError(404, `Backup file not found: ${req.params.filename}`)
  fs.unlinkSync(file)
  removeCatalogEntry(req.params.filename)
  res.json({ ok: true })
}))

module.exports = { router }
