const childProcess = require('child_process')
const { execEnv } = require('../servers')
const { registerEngineImages } = require('../docker')
const { capture } = require('../connectivity/process')
const { createMysqlDriver } = require('./mysql-common')

// MySQL / MariaDB / Percona running in a Docker container. The client tools
// of the container itself run through `docker exec`; dumps stream out on
// stdout and restores stream in on stdin.
//
// Credentials come from the container's own environment (official images):
// MARIADB_ROOT_PASSWORD / MYSQL_ROOT_PASSWORD or their *_FILE variants. The
// shell snippet below writes them to a mktemp option file (mode 0600, removed
// on exit) for `--defaults-extra-file`, so nothing secret is on any command
// line. User input only ever arrives as positional arguments ("$@").

registerEngineImages('mysql', ['mysql', 'mariadb', 'percona'])

const QUERY_TIMEOUT_MS = 60000

// $1 = 'dump' | 'client', remaining arguments go to the tool.
const MYSQL_SH = [
  'tool=$1; shift',
  'if [ "$tool" = dump ]; then cli=$(command -v mariadb-dump || command -v mysqldump)',
  'else cli=$(command -v mariadb || command -v mysql); fi',
  'if [ -z "$cli" ]; then echo "No MySQL/MariaDB client tools found in the container" >&2; exit 127; fi',
  'pw="$MARIADB_ROOT_PASSWORD"; [ -n "$pw" ] || pw="$MYSQL_ROOT_PASSWORD"',
  'pf="$MARIADB_ROOT_PASSWORD_FILE"; [ -n "$pf" ] || pf="$MYSQL_ROOT_PASSWORD_FILE"',
  'if [ -z "$pw" ] && [ -n "$pf" ] && [ -r "$pf" ]; then pw=$(cat "$pf"); fi',
  'cnf=$(mktemp) || exit 1',
  'trap \'rm -f "$cnf"\' EXIT',
  'esc=$(printf "%s" "$pw" | sed \'s/\\\\/\\\\\\\\/g; s/"/\\\\"/g\')',
  'printf \'[client]\\nuser=root\\npassword="%s"\\n\' "$esc" > "$cnf"',
  '"$cli" --defaults-extra-file="$cnf" "$@"',
].join('\n')

function execArgs(target, tool, args, interactive) {
  return ['exec', ...(interactive ? ['-i'] : []), target.container, 'sh', '-c', MYSQL_SH, 'sh', tool, ...args]
}

async function open(target, fn) {
  const env = { ...process.env, ...(await execEnv(target.server)) }
  return fn({
    spawn: (tool, args) => childProcess.spawn('docker', execArgs(target, tool, args, tool === 'client'), { env }),
    capture: (tool, args) => capture('docker', execArgs(target, tool, args, false), { env, timeout: QUERY_TIMEOUT_MS }),
  })
}

module.exports = {
  ...createMysqlDriver({ kind: 'docker', open }),
  _internals: { MYSQL_SH, execArgs, open },
}
