const { getDb, migrate } = require('../db')

// Users table access. Rows returned by the "public" helpers never include
// the password hash; only findForLogin() exposes it to the auth layer.

const ROLES = ['admin', 'user']

function initSchema() {
  migrate('users-001-users', `
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      display_name TEXT NOT NULL DEFAULT '',
      email TEXT NOT NULL DEFAULT '',
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('admin', 'user')),
      disabled INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_login_at INTEGER
    );
  `)
  migrate('users-002-sessions', `
    CREATE TABLE sessions (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      ip TEXT NOT NULL DEFAULT '',
      user_agent TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX sessions_user_id ON sessions(user_id);
  `)
}

/** Shape sent to clients and stored on req.user (no secrets). */
function toPublicUser(row) {
  if (!row) return null
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    email: row.email,
    role: row.role,
    disabled: !!row.disabled,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastLoginAt: row.last_login_at ?? null,
  }
}

const PUBLIC_COLUMNS = 'id, username, display_name, email, role, disabled, created_at, updated_at, last_login_at'

function countUsers() {
  return getDb().prepare('SELECT COUNT(*) AS n FROM users').get().n
}

function countActiveAdmins() {
  return getDb().prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND disabled = 0").get().n
}

function listUsers() {
  return getDb().prepare(`SELECT ${PUBLIC_COLUMNS} FROM users ORDER BY username`).all().map(toPublicUser)
}

function getUser(id) {
  return toPublicUser(getDb().prepare(`SELECT ${PUBLIC_COLUMNS} FROM users WHERE id = ?`).get(id))
}

/** Row including password_hash, for credential checks only. */
function findForLogin(username) {
  if (typeof username !== 'string' || !username) return null
  return getDb().prepare('SELECT * FROM users WHERE username = ?').get(username) ?? null
}

function getPasswordHash(id) {
  return getDb().prepare('SELECT password_hash FROM users WHERE id = ?').get(id)?.password_hash ?? null
}

function usernameTaken(username) {
  return !!getDb().prepare('SELECT 1 FROM users WHERE username = ?').get(username)
}

/**
 * Insert a user. `passwordHash` must already be hashed.
 * @returns {object} the public user
 */
function createUser({ username, displayName = '', email = '', passwordHash, role = 'user' }) {
  const now = Date.now()
  const { lastInsertRowid } = getDb().prepare(`
    INSERT INTO users (username, display_name, email, password_hash, role, disabled, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 0, ?, ?)
  `).run(username, displayName, email, passwordHash, role, now, now)
  return getUser(Number(lastInsertRowid))
}

const UPDATABLE = {
  displayName: 'display_name',
  email: 'email',
  role: 'role',
  disabled: 'disabled',
  passwordHash: 'password_hash',
}

/**
 * Update the given fields (camelCase keys from UPDATABLE).
 * @returns {object|null} the updated public user
 */
function updateUser(id, changes) {
  const entries = Object.entries(changes).filter(([k, v]) => UPDATABLE[k] && v !== undefined)
  if (entries.length) {
    const sets = entries.map(([k]) => `${UPDATABLE[k]} = ?`).join(', ')
    const values = entries.map(([k, v]) => (k === 'disabled' ? (v ? 1 : 0) : v))
    getDb().prepare(`UPDATE users SET ${sets}, updated_at = ? WHERE id = ?`).run(...values, Date.now(), id)
  }
  return getUser(id)
}

function touchLastLogin(id) {
  getDb().prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(Date.now(), id)
}

function deleteUser(id) {
  return getDb().prepare('DELETE FROM users WHERE id = ?').run(id).changes > 0
}

module.exports = {
  ROLES,
  initSchema,
  toPublicUser,
  countUsers,
  countActiveAdmins,
  listUsers,
  getUser,
  findForLogin,
  getPasswordHash,
  usernameTaken,
  createUser,
  updateUser,
  touchLastLogin,
  deleteUser,
}
