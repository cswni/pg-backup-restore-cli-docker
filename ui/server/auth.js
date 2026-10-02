const crypto = require('crypto')

/**
 * HTTP Basic authentication middleware.
 *
 * Fails closed: BASIC_AUTH_USER and BASIC_AUTH_PASSWORD are required, and
 * the server refuses to start without them. Auth can only be turned off
 * explicitly with BASIC_AUTH_DISABLED=true (e.g. local development), in
 * which case this returns null.
 */
function createBasicAuth({ user, password, disabled, realm = 'PG Backup & Restore' }) {
  if (disabled) return null
  if (!user || !password) {
    throw new Error(
      'BASIC_AUTH_USER and BASIC_AUTH_PASSWORD must be set. ' +
      'Set BASIC_AUTH_DISABLED=true to run without authentication (not recommended).'
    )
  }

  const expected = crypto.createHash('sha256').update(`${user}:${password}`).digest()

  // Compare SHA-256 digests so timingSafeEqual always gets equal-length buffers
  const matches = (given) => {
    const digest = crypto.createHash('sha256').update(given).digest()
    return crypto.timingSafeEqual(digest, expected)
  }

  return (req, res, next) => {
    const header = req.headers.authorization || ''
    const [scheme, encoded] = header.split(' ')
    if (scheme === 'Basic' && encoded && matches(Buffer.from(encoded, 'base64'))) {
      return next()
    }
    res.setHeader('WWW-Authenticate', `Basic realm="${realm}", charset="UTF-8"`)
    res.status(401).json({ error: 'Authentication required' })
  }
}

module.exports = { createBasicAuth }
