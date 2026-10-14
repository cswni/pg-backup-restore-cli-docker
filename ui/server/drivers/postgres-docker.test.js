const path = require('path')
const { setupTestEnv } = require('../test-helpers')
const env = setupTestEnv()

const { test, mock, beforeEach } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const childProcess = require('child_process')
const { installSpawnFake } = require('../explorer/test-fakes')
const driver = require('./postgres-docker')
const { dockerAdapter } = require('../explorer/postgres')
const store = require('../containercreds/store')
const { LOCAL_SERVER } = require('../servers')
const REPO_SCRIPTS = path.join(__dirname, '..', '..', '..', 'scripts')

const fake = installSpawnFake(mock, ['docker'])
const target = { server: LOCAL_SERVER, container: 'pg16' }
const SECRET = 'pg-secret-123'

beforeEach(() => {
  fake.calls.length = 0
  fake.respond(() => ' shop | postgres | UTF8\n template0 | postgres | UTF8\n postgres | postgres | UTF8\n')
  for (const c of store.listCredentials('local')) store.deleteCredentials('local', c.key)
})

test('listDatabases runs psql -lqt as the postgres OS user without saved credentials', async () => {
  assert.deepEqual(await driver.listDatabases(target), ['shop', 'postgres'])
  assert.deepEqual(fake.calls[0].args, ['exec', '-u', 'postgres', 'pg16', 'psql', '-lqt'])
})

test('listDatabases forwards saved credentials with -e NAME, the password only in the env', async () => {
  store.saveCredentials('local', 'core', { engine: 'postgres', username: 'app', password: SECRET, osUser: '', host: '127.0.0.1' })
  await driver.listDatabases({ server: LOCAL_SERVER, container: 'core' })
  const call = fake.calls[0]
  assert.deepEqual(call.args, ['exec', '-e', 'PGUSER', '-e', 'PGPASSWORD', '-e', 'PGHOST', 'core', 'psql', '-lqt'])
  assert.equal(call.env.PGPASSWORD, SECRET)
  assert.equal(call.env.PGUSER, 'app')
  assert.ok(!call.args.some((a) => a.includes(SECRET)))
})

test('a custom OS user is passed to docker exec -u', async () => {
  store.saveCredentials('local', 'pg16', { engine: 'postgres', username: 'postgres', password: '', osUser: 'pgadmin' })
  await driver.listDatabases(target)
  assert.deepEqual(fake.calls[0].args, ['exec', '-u', 'pgadmin', '-e', 'PGUSER', 'pg16', 'psql', '-lqt'])
})

test('script environment: defaults keep the postgres OS user and clear libpq variables', async () => {
  const defaults = await driver._internals.scriptEnv(target)
  assert.deepEqual(defaults, { PG_EXEC_USER: 'postgres', PGUSER: '', PGPASSWORD: '', PGHOST: '' })

  store.saveCredentials('local', 'pg16', { engine: 'postgres', username: 'app', password: SECRET, osUser: '', host: null })
  assert.deepEqual(await driver._internals.scriptEnv(target), { PG_EXEC_USER: '', PGUSER: 'app', PGPASSWORD: SECRET, PGHOST: '' })
})

test('the explorer uses the saved credentials too', async () => {
  store.saveCredentials('local', 'pg16', { engine: 'postgres', username: 'app', password: SECRET, osUser: '' })
  fake.respond(() => '')
  await dockerAdapter.open(target, 'shop', (s) => s.objects())
  const call = fake.calls[0]
  assert.deepEqual(call.args.slice(0, 7), ['exec', '-e', 'PGUSER', '-e', 'PGPASSWORD', '-e', 'PGCLIENTENCODING=UTF8'])
  assert.equal(call.env.PGPASSWORD, SECRET)
  assert.ok(!call.args.some((a) => a.includes(SECRET)))
})

// Runs the real scripts with a fake docker on PATH (needs Git Bash on Windows).
const hasBash = childProcess.spawnSync('bash', ['-c', 'echo ok']).stdout?.toString().trim() === 'ok'

function runScript(name, extraEnv) {
  const bin = fs.mkdtempSync(path.join(env.root, 'bin-'))
  fs.writeFileSync(path.join(bin, 'docker'), '#!/bin/sh\nfor a in "$@"; do printf "ARG:%s\\n" "$a"; done\nprintf "PGPASSWORD=%s\\n" "${PGPASSWORD-unset}"\n', { mode: 0o755 })
  const scriptPath = path.join(REPO_SCRIPTS, name).replace(/\\/g, '/')
  const res = childProcess.spawnSync('bash', [scriptPath, '-c', 'pg16', '-d', 'shop'], {
    env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, ...extraEnv },
  })
  const out = res.stdout.toString()
  return {
    status: res.status,
    stderr: res.stderr.toString(),
    args: out.split('\n').filter((l) => l.startsWith('ARG:')).map((l) => l.slice(4)),
    password: (out.match(/^PGPASSWORD=(.*)$/m) || [])[1],
  }
}

test('pg-create.sh keeps docker exec -u postgres when nothing is set', { skip: !hasBash && 'bash not available' }, () => {
  const res = runScript('pg-create.sh', { PG_EXEC_USER: undefined, PGUSER: '', PGPASSWORD: '', PGHOST: '' })
  assert.equal(res.status, 0, res.stderr)
  assert.deepEqual(res.args.slice(0, 6), ['exec', '-u', 'postgres', 'pg16', 'psql', '-d'])
})

test('pg-create.sh honours PG_EXEC_USER and forwards PGUSER / PGPASSWORD / PGHOST by name', { skip: !hasBash && 'bash not available' }, () => {
  const res = runScript('pg-create.sh', { PG_EXEC_USER: '', PGUSER: 'app', PGPASSWORD: SECRET, PGHOST: '127.0.0.1' })
  assert.equal(res.status, 0, res.stderr)
  assert.deepEqual(res.args.slice(0, 8), ['exec', '-e', 'PGUSER', '-e', 'PGPASSWORD', '-e', 'PGHOST', 'pg16'])
  assert.ok(!res.args.some((a) => a.includes(SECRET)))
  assert.equal(res.password, SECRET)

  const custom = runScript('pg-unblock.sh', { PG_EXEC_USER: 'pgadmin', PGUSER: '', PGPASSWORD: '', PGHOST: '' })
  assert.deepEqual(custom.args.slice(0, 4), ['exec', '-u', 'pgadmin', 'pg16'])
})
