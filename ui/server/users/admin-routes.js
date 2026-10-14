const express = require('express')
const { requireAdmin } = require('../auth')
const { httpError } = require('../validation')
const { handle } = require('../routes/util')
const store = require('./store')
const sessions = require('./sessions')
const validate = require('./validate')
const { hashPassword } = require('./passwords')

// /api/users: admin-managed accounts. requireAdmin is applied per route:
// this router is mounted on /api, so router.use() would affect every route.

const router = express.Router()

function findTarget(req) {
  const { id } = req.params
  if (!/^\d+$/.test(id)) throw httpError(400, 'Invalid user id')
  const user = store.getUser(Number(id))
  if (!user) throw httpError(404, 'User not found')
  return user
}

const isActiveAdmin = (u) => u.role === 'admin' && !u.disabled

/** Refuse changes that would leave no active admin. */
function guardLastAdmin(target, next) {
  if (isActiveAdmin(target) && !isActiveAdmin(next) && store.countActiveAdmins() <= 1) {
    throw httpError(409, 'Cannot remove, disable or demote the last active admin')
  }
}

router.get('/users', requireAdmin, handle(async (req, res) => {
  res.json(store.listUsers())
}))

router.post('/users', requireAdmin, handle(async (req, res) => {
  const body = validate.body(req)
  const username = validate.username(body.username)
  const password = validate.password(body.password)
  const fields = {
    displayName: validate.displayName(body.displayName) ?? '',
    email: validate.email(body.email) ?? '',
    role: validate.role(body.role) ?? 'user',
  }
  if (store.usernameTaken(username)) throw httpError(409, `Username '${username}' is already taken`)
  const user = store.createUser({ username, ...fields, passwordHash: await hashPassword(password) })
  res.status(201).json(user)
}))

router.put('/users/:id', requireAdmin, handle(async (req, res) => {
  const body = validate.body(req)
  const target = findTarget(req)
  const changes = {
    displayName: validate.displayName(body.displayName),
    email: validate.email(body.email),
    role: validate.role(body.role),
    disabled: validate.disabled(body.disabled),
  }
  const password = body.password === undefined || body.password === '' ? undefined : validate.password(body.password)
  const isSelf = target.id === req.user.id

  if (isSelf && changes.disabled) throw httpError(409, 'You cannot disable your own account')
  guardLastAdmin(target, { role: changes.role ?? target.role, disabled: changes.disabled ?? target.disabled })

  const updated = store.updateUser(target.id, {
    ...changes,
    passwordHash: password ? await hashPassword(password) : undefined,
  })
  if (changes.disabled || password) {
    // Keep the caller's own session when an admin resets their own password
    sessions.revokeUserSessions(target.id, isSelf ? (req.auth?.tokenHash ?? null) : null)
  }
  res.json(updated)
}))

router.delete('/users/:id', requireAdmin, handle(async (req, res) => {
  const target = findTarget(req)
  if (target.id === req.user.id) throw httpError(409, 'You cannot delete your own account')
  guardLastAdmin(target, { role: 'user', disabled: true })
  store.deleteUser(target.id) // sessions are removed by ON DELETE CASCADE
  res.json({ ok: true })
}))

module.exports = { router }
