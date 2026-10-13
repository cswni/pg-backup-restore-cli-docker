const crypto = require('crypto')
const { promisify } = require('util')

const scrypt = promisify(crypto.scrypt)

const MIN_PASSWORD_LENGTH = 10
const MAX_PASSWORD_LENGTH = 1024
const KEY_LENGTH = 64
const SALT_BYTES = 16
// N=2^15 (≈32 MB with r=8): OWASP-recommended minimum for scrypt
const DEFAULT_PARAMS = { N: 32768, r: 8, p: 1 }
const scryptOptions = ({ N, r, p }) => ({ N, r, p, maxmem: 128 * N * r * 2 })

/**
 * Validate a new password against the policy.
 * @returns {string|null} error message, or null when acceptable
 */
function passwordPolicyError(password) {
  if (typeof password !== 'string') return 'Password is required'
  if (password.length < MIN_PASSWORD_LENGTH) return `Password must be at least ${MIN_PASSWORD_LENGTH} characters`
  if (password.length > MAX_PASSWORD_LENGTH) return `Password must be at most ${MAX_PASSWORD_LENGTH} characters`
  return null
}

/**
 * Hash a password with scrypt and a random salt.
 * Format: scrypt$N$r$p$<salt b64>$<hash b64> (params travel with the hash).
 */
async function hashPassword(password) {
  const salt = crypto.randomBytes(SALT_BYTES)
  return formatHash(salt, await scrypt(password, salt, KEY_LENGTH, scryptOptions(DEFAULT_PARAMS)))
}

/** Synchronous hashPassword() for startup code (bootstrap runs before listen). */
function hashPasswordSync(password) {
  const salt = crypto.randomBytes(SALT_BYTES)
  return formatHash(salt, crypto.scryptSync(password, salt, KEY_LENGTH, scryptOptions(DEFAULT_PARAMS)))
}

function formatHash(salt, key) {
  const { N, r, p } = DEFAULT_PARAMS
  return ['scrypt', N, r, p, salt.toString('base64'), key.toString('base64')].join('$')
}

function parseHash(stored) {
  const parts = typeof stored === 'string' ? stored.split('$') : []
  if (parts.length !== 6 || parts[0] !== 'scrypt') return null
  const [N, r, p] = parts.slice(1, 4).map(Number)
  if (![N, r, p].every(Number.isInteger)) return null
  return { N, r, p, salt: Buffer.from(parts[4], 'base64'), key: Buffer.from(parts[5], 'base64') }
}

/** Constant-time check of a password against a stored hash. */
async function verifyPassword(password, stored) {
  const parsed = parseHash(stored)
  if (!parsed || typeof password !== 'string' || password.length > MAX_PASSWORD_LENGTH) return false
  const key = await scrypt(password, parsed.salt, parsed.key.length, scryptOptions(parsed))
  return crypto.timingSafeEqual(key, parsed.key)
}

// Hash of a random password, verified when the username does not exist so
// the response time does not reveal which usernames are valid.
let dummyHash = null
async function verifyDummy(password) {
  dummyHash ??= await hashPassword(crypto.randomBytes(16).toString('hex'))
  await verifyPassword(typeof password === 'string' ? password : '', dummyHash)
  return false
}

module.exports = { MIN_PASSWORD_LENGTH, passwordPolicyError, hashPassword, hashPasswordSync, verifyPassword, verifyDummy }
