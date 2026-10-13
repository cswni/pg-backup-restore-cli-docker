const path = require('path')

// Central runtime configuration. Every module reads settings from here
// instead of process.env so defaults live in one place.
const BACKUPS_DIR = process.env.BACKUPS_DIR || '/backups'

module.exports = {
  PORT: Number(process.env.PORT) || 3000,
  BACKUPS_DIR,
  // App state (SQLite DB, secret key, job logs). Defaults inside the backups
  // volume so existing deployments persist it without a new mount.
  DATA_DIR: process.env.DATA_DIR || path.join(BACKUPS_DIR, '.pgui'),
  SCRIPTS_DIR: process.env.SCRIPTS_DIR || '/usr/local/bin',
  DIST_DIR: path.join(__dirname, '..', 'dist'),
}
