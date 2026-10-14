const childProcess = require('child_process')
const { execEnv } = require('../servers')
const { registerEngineImages } = require('../docker')
const { capture } = require('../connectivity/process')
const { createMongoDriver } = require('./mongodb-common')
const { clientAccessEnv } = require('../containercreds/access')

// MongoDB running in a Docker container. mongodump / mongorestore of the
// container run through `docker exec` (archive on stdout / stdin); listing
// and dropping databases use the container's mongosh (MongoDB 6.0+ images).
//
// Credentials: saved container credentials when an admin set them
// (PGUI_DB_USER / PGUI_DB_PASSWORD / PGUI_DB_AUTHSOURCE, forwarded with
// `docker exec -e NAME`), otherwise the container's environment (official
// image): MONGO_INITDB_ROOT_USERNAME / MONGO_INITDB_ROOT_PASSWORD or their
// *_FILE variants, authSource admin; no authentication when unset. The
// password reaches the tools through a mktemp YAML file (--config, mode 0600,
// removed on exit) and mongosh through its environment, never on a command line.

registerEngineImages('mongodb', ['mongo'])

const QUERY_TIMEOUT_MS = 60000

// $1 = 'mongodump' | 'mongorestore' | 'shell'.
// shell: $2 = JavaScript program, $3 = action, $4 = database (read via process.env)
const MONGO_SH = String.raw`
tool=$1; shift
if [ -n "$PGUI_DB_USER" ]; then
  user="$PGUI_DB_USER"; pw="$PGUI_DB_PASSWORD"
else
  user="$MONGO_INITDB_ROOT_USERNAME"; uf="$MONGO_INITDB_ROOT_USERNAME_FILE"
  if [ -z "$user" ] && [ -n "$uf" ] && [ -r "$uf" ]; then user=$(cat "$uf"); fi
  pw="$MONGO_INITDB_ROOT_PASSWORD"; pf="$MONGO_INITDB_ROOT_PASSWORD_FILE"
  if [ -z "$pw" ] && [ -n "$pf" ] && [ -r "$pf" ]; then pw=$(cat "$pf"); fi
fi
authdb="$PGUI_DB_AUTHSOURCE"; [ -n "$authdb" ] || authdb=admin
if [ "$tool" = shell ]; then
  command -v mongosh >/dev/null 2>&1 || { echo "mongosh not found in the container (MongoDB 6.0+ images include it)" >&2; exit 127; }
  export PGUI_USER="$user" PGUI_PASSWORD="$pw" PGUI_AUTHDB="$authdb" PGUI_ACTION="$2" PGUI_DB="$3"
  exec mongosh --quiet --norc --eval "$1"
fi
case "$tool" in mongodump|mongorestore) ;; *) echo "unsupported tool: $tool" >&2; exit 2 ;; esac
command -v "$tool" >/dev/null 2>&1 || { echo "$tool not found in the container" >&2; exit 127; }
if [ -z "$user" ]; then exec "$tool" "$@"; fi
cfg=$(mktemp) || exit 1
trap 'rm -f "$cfg"' EXIT
printf "password: '%s'\n" "$(printf '%s' "$pw" | sed "s/'/''/g")" > "$cfg"
"$tool" --username="$user" --authenticationDatabase="$authdb" --config="$cfg" "$@"
`

// mongosh program: authenticates from the environment, prints one JSON line.
const MONGO_JS = String.raw`
const env = process.env
const admin = db.getSiblingDB('admin')
if (env.PGUI_USER) db.getSiblingDB(env.PGUI_AUTHDB || 'admin').auth(env.PGUI_USER, env.PGUI_PASSWORD)
let result
if (env.PGUI_ACTION === 'list') {
  result = admin.adminCommand({ listDatabases: 1, nameOnly: true }).databases.map((d) => d.name)
} else if (env.PGUI_ACTION === 'count') {
  result = db.getSiblingDB(env.PGUI_DB).getCollectionNames().filter((c) => !c.startsWith('system.')).length
} else if (env.PGUI_ACTION === 'drop') {
  const r = db.getSiblingDB(env.PGUI_DB).dropDatabase()
  if (!r.ok) throw new Error('dropDatabase failed: ' + JSON.stringify(r))
  result = true
} else if (env.PGUI_ACTION === 'version') {
  result = db.version()
} else {
  throw new Error('unknown action ' + env.PGUI_ACTION)
}
print(JSON.stringify({ result }))
`

/** `envNames`: saved-credential variables to forward (see dockerEnv). */
function execArgs(target, tool, args, interactive = false, envNames = []) {
  return [
    'exec', ...(interactive ? ['-i'] : []), ...envNames.flatMap((n) => ['-e', n]),
    target.container, 'sh', '-c', MONGO_SH, 'sh', tool, ...args,
  ]
}

/** Environment of the local docker process and the variable names to forward. */
async function dockerEnv(target) {
  const saved = clientAccessEnv(target, 'mongodb')
  return { env: { ...process.env, ...(await execEnv(target.server)), ...saved }, names: Object.keys(saved) }
}

/** Parse the JSON line printed by MONGO_JS. */
function parseShellOutput(out) {
  const line = out.trim().split('\n').reverse().find((l) => l.trim().startsWith('{"result"'))
  if (!line) throw new Error(`Unexpected mongosh output: ${out.trim().slice(0, 200)}`)
  return JSON.parse(line).result
}

async function open(target, fn) {
  const { env, names } = await dockerEnv(target)
  const shell = async (action, database = '') =>
    parseShellOutput(await capture('docker', execArgs(target, 'shell', [MONGO_JS, action, database], false, names), { env, timeout: QUERY_TIMEOUT_MS }))
  return fn({
    spawn: (tool, args) => childProcess.spawn('docker', execArgs(target, tool, args, tool === 'mongorestore', names), { env }),
    listDatabases: () => shell('list'),
    countCollections: (database) => shell('count', database).then(Number),
    dropDatabase: async (database) => { await shell('drop', database) },
    version: () => shell('version'),
  })
}

module.exports = {
  ...createMongoDriver({ kind: 'docker', open }),
  _internals: { MONGO_SH, MONGO_JS, execArgs, dockerEnv, parseShellOutput },
}
