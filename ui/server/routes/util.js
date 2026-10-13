/**
 * Wrap an async route handler: errors with `status` become that HTTP status,
 * anything else a 500, always as { error }.
 */
function handle(fn) {
  return async (req, res, next) => {
    try {
      await fn(req, res, next)
    } catch (err) {
      if (res.headersSent) return next(err)
      res.status(err.status || 500).json({ error: err.message })
    }
  }
}

module.exports = { handle }
