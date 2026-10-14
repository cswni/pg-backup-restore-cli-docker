const store = require('./store')
const { router } = require('./routes')

// Per-container database credentials for Docker servers (see store.js).
module.exports = { init: store.init, router }
