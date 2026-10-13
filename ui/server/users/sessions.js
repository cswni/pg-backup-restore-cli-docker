const crypto = require('crypto')
const { getDb } = require('../db')
const { toPublicUser } = require('./store')

// Server-side sessions. The browser holds a random token in an HttpOnly
// cookie; the database only stores its SHA-256 hash, so a leaked DB file
// cannot be replayed as a session.

const SESSION_COOKIE = 'pgui_session'
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000
// Sliding expiry is refreshed at most this often to avoid a write per request
const REFRESH_AFTER_MS = 60 * 60 * 1000
const MAX_UA_LENGTH = 256

const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex')

/**
 * Create a session for a user.
 * @returns {{ token: string, tokenHash: string, expiresAt: number }}
 */
function createSession(userId, { ip = '', userAgent = '' } = {}) {
  const token = crypto.randomBytes(32).toString('base64url')
  const tokenHash = hashToken(token)
  const now = Date.now()
  const expiresAt = now + SESSION_TTL_MS
  getDb().prepare(`
    INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_seen_at, ip, user_agent)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(tokenHash, userId, now, expiresAt, now, String(ip || ''), String(userAgent || '').slice(0, MAX_UA_LENGTH))
  return { token, tokenHash, expiresAt }
}

/**
 * Resolve a session token to its (enabled) user, extending the expiry when due.
 * @returns {{ user: object, tokenHash: string, refreshed: boolean } | null}
 */
function findSession(token) {
  if (typeof token !== 'string' || !token) return null
  const tokenHash = hashToken(token)
  const now = Date.now()
  const row = getDb().prepare(`
    SELECT s.token_hash, s.expires_at, s.last_seen_at, u.*
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > ? AND u.disabled = 0
  `).get(tokenHash, now)
  if (!row) return null

  const refreshed = now - row.last_seen_at > REFRESH_AFTER_MS
  if (refreshed) {
    getDb().prepare('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE token_hash = ?')
      .run(now, now + SESSION_TTL_MS, tokenHash)
  }
  return { user: toPublicUser(row), tokenHash, refreshed }
}

function deleteSession(token) {
  if (typeof token !== 'string' || !token) return
  getDb().prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token))
}

/** Revoke all sessions of a user, optionally keeping one (by token hash). */
function revokeUserSessions(userId, exceptTokenHash = null) {
  getDb().prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash IS NOT ?').run(userId, exceptTokenHash)
}

function purgeExpiredSessions() {
  getDb().prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now())
}

/** Read one cookie from the raw Cookie header (no cookie-parser dependency). */
function readCookie(req, name) {
  const header = req.headers.cookie
  if (!header) return null
  for (const part of header.split(';')) {
    const idx = part.indexOf('=')
    if (idx === -1) continue
    if (part.slice(0, idx).trim() === name) {
      try { return decodeURIComponent(part.slice(idx + 1).trim()) } catch { return null }
    }
  }
  return null
}

const cookieOptions = (req) => ({
  httpOnly: true,
  sameSite: 'lax',
  secure: req.secure,
  path: '/',
})

function setSessionCookie(req, res, token) {
  res.cookie(SESSION_COOKIE, token, { ...cookieOptions(req), maxAge: SESSION_TTL_MS })
}

function clearSessionCookie(req, res) {
  res.clearCookie(SESSION_COOKIE, cookieOptions(req))
}

module.exports = {
  SESSION_COOKIE,
  SESSION_TTL_MS,
  hashToken,
  createSession,
  findSession,
  deleteSession,
  revokeUserSessions,
  purgeExpiredSessions,
  readCookie,
  setSessionCookie,
  clearSessionCookie,
}
