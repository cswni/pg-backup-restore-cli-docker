// Feature modules, loaded in order by app.js.
//
// A module exports any of:
//   init()                 — one-time startup (migrations, timers, step registration)
//   router                 — express.Router mounted under /api (after auth)
//   publicRouter           — express.Router mounted under /api BEFORE auth
//                            (login, health checks, OAuth callbacks)
//
// To add a feature, create server/<feature>/index.js and add one line here.
module.exports = [
  require('./jobs'),
  require('./catalog'),
  require('./settings'),
  require('./routes/containers'),
  require('./routes/backups'),
  require('./routes/ops'),
  require('./routes/uploads'),
  require('./routes/jobs'),
  require('./scheduler'),
]
