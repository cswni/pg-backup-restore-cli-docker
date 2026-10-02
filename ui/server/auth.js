const crypto = require('crypto')

/**
 * HTTP Basic authentication middleware.
 * Enabled when BASIC_AUTH_USER and BASIC_AUTH_PASSWORD are set.
 * Returns null when auth is disabled (neither variable set).
 * Throws when only one of the two is set, so a half-configured
 * deployment never runs unprotected by accident.
 */
function createBasicAuth({ user, password, realm = 'PG Backup & Restore' }) {
  if (!user && !password) return null
  if (!user || !password) {
    throw new Error('BASIC_AUTH_USER and BASIC_AUTH_PASSWORD must both be set (or both empty to disable auth)')
  }

  const expected = Buffer.from(`${user}:${password}`)

  // Compare SHA-256 digests so timingSafeEqual always gets equal-length buffers
  const matches = (given) => {
    const a = crypto.createHash('sha256').update(given).digest()
    const b = crypto.createHash('sha256').update(expected).digest()
    return crypto.timingSafeEqual(a, b)
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
