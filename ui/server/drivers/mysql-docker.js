const childProcess = require('child_process')
const { execEnv } = require('../servers')
const { registerEngineImages } = require('../docker')
const { capture } = require('../connectivity/process')
const { createMysqlDriver } = require('./mysql-common')
const { clientAccessEnv } = require('../containercreds/access')

// MySQL / MariaDB / Percona running in a Docker container. The client tools
// of the container itself run through `docker exec`; dumps stream out on
// stdout and restores stream in on stdin.
//
// Credentials: saved container credentials when an admin set them
// (PGUI_DB_USER / PGUI_DB_PASSWORD, forwarded with `docker exec -e NAME`),
// otherwise root with the container's own MARIADB_ROOT_PASSWORD /
// MYSQL_ROOT_PASSWORD or their *_FILE variants. The shell snippet below writes
// them to a mktemp option file (mode 0600, removed on exit) for
// `--defaults-extra-file`, so nothing secret is on any command line. User
// input only ever arrives as positional arguments ("$@").

registerEngineImages('mysql', ['mysql', 'mariadb', 'percona'])

const QUERY_TIMEOUT_MS = 60000

// $1 = 'dump' | 'client', remaining arguments go to the tool.
const MYSQL_SH = [
  'tool=$1; shift',
  'if [ "$tool" = dump ]; then cli=$(command -v mariadb-dump || command -v mysqldump)',
  'else cli=$(command -v mariadb || command -v mysql); fi',
  'if [ -z "$cli" ]; then echo "No MySQL/MariaDB client tools found in the container" >&2; exit 127; fi',
  'if [ -n "$PGUI_DB_USER" ]; then user="$PGUI_DB_USER"; pw="$PGUI_DB_PASSWORD"; else',
  '  user=root; pw="$MARIADB_ROOT_PASSWORD"; [ -n "$pw" ] || pw="$MYSQL_ROOT_PASSWORD"',
  '  pf="$MARIADB_ROOT_PASSWORD_FILE"; [ -n "$pf" ] || pf="$MYSQL_ROOT_PASSWORD_FILE"',
  '  if [ -z "$pw" ] && [ -n "$pf" ] && [ -r "$pf" ]; then pw=$(cat "$pf"); fi',
  'fi',
  'cnf=$(mktemp) || exit 1',
  'trap \'rm -f "$cnf"\' EXIT',
  'q() { printf "%s" "$1" | sed \'s/\\\\/\\\\\\\\/g; s/"/\\\\"/g\'; }',
  'printf \'[client]\\nuser="%s"\\npassword="%s"\\n\' "$(q "$user")" "$(q "$pw")" > "$cnf"',
  '"$cli" --defaults-extra-file="$cnf" "$@"',
].join('\n')

/** `envNames`: saved-credential variables to forward (see dockerEnv). */
function execArgs(target, tool, args, interactive, envNames = []) {
  return [
    'exec', ...(interactive ? ['-i'] : []), ...envNames.flatMap((n) => ['-e', n]),
    target.container, 'sh', '-c', MYSQL_SH, 'sh', tool, ...args,
  ]
}

/** Environment of the local docker process and the variable names to forward. */
async function dockerEnv(target) {
  const saved = clientAccessEnv(target, 'mysql')
  return { env: { ...process.env, ...(await execEnv(target.server)), ...saved }, names: Object.keys(saved) }
}

async function open(target, fn) {
  const { env, names } = await dockerEnv(target)
  return fn({
    spawn: (tool, args) => childProcess.spawn('docker', execArgs(target, tool, args, tool === 'client', names), { env }),
    capture: (tool, args) => capture('docker', execArgs(target, tool, args, false, names), { env, timeout: QUERY_TIMEOUT_MS }),
  })
}

module.exports = {
  ...createMysqlDriver({ kind: 'docker', open }),
  _internals: { MYSQL_SH, execArgs, open },
}
