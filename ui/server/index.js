const { PORT } = require('./config')
const { createApp } = require('./app')

let app
try {
  app = createApp()
} catch (err) {
  console.error(`[pg-backup-ui] FATAL: ${err.message}`)
  process.exit(1)
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[pg-backup-ui] Web UI running at http://0.0.0.0:${PORT}`)
})
