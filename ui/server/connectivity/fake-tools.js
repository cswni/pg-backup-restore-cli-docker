// Test support: stand-ins for psql, pg_dump and ssh so driver and tunnel
// tests run without PostgreSQL or an SSH server. Only used by *.test.js.
const fs = require('fs')
const path = require('path')
const childProcess = require('child_process')

const realSpawn = childProcess.spawn

// Executed as: node fake-tools.js <stateFile> <command> ...args
const FAKE_SCRIPT = String.raw`
const fs = require('fs')
const net = require('net')
const [stateFile, cmd, ...args] = process.argv.slice(2)
const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
const ENV_KEYS = ['PGHOST', 'PGHOSTADDR', 'PGPORT', 'PGUSER', 'PGPASSWORD', 'PGSSLMODE', 'PGCONNECT_TIMEOUT']
const env = Object.fromEntries(ENV_KEYS.filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]]))
const record = (extra) => fs.appendFileSync(stateFile + '.log', JSON.stringify({ cmd, args, env, ...extra }) + '\n')
const dbArg = () => args[args.indexOf('-d') + 1]

if (cmd === 'pg_dump') {
  record({})
  process.stdout.write(state.dump || '')
  if (state.dumpStderr) process.stderr.write(state.dumpStderr)
  process.exitCode = state.dumpExit || 0
} else if (cmd === 'psql' && args.includes('-c')) {
  const sql = args[args.indexOf('-c') + 1]
  record({ sql })
  if (state.failSql && sql.includes(state.failSql)) { process.stderr.write('ERROR:  ' + state.failSql + ' failed\n'); process.exit(1) }
  const m = sql.match(/datname = '([^']+)'/)
  if (/SELECT 1 FROM pg_database/.test(sql)) console.log((state.existing || []).includes(m[1]) ? '1' : '')
  else if (/SELECT count\(\*\) FROM pg_class/.test(sql)) console.log(String((state.tables || {})[dbArg()] || 0))
  else if (/SELECT datname FROM pg_database/.test(sql)) console.log((state.existing || []).join('\n'))
  else if (/SELECT version\(\)/.test(sql)) console.log('PostgreSQL 18.0 (fake)')
} else if (cmd === 'psql') {
  const chunks = []
  process.stdin.on('data', (d) => chunks.push(d))
  process.stdin.on('end', () => {
    record({ stdin: Buffer.concat(chunks).toString() })
    process.stdout.write('SET\nCREATE TABLE\n')
    if (state.restoreStderr) process.stderr.write(state.restoreStderr)
  })
} else if (cmd === 'ssh') {
  record({})
  if (state.sshFail) { process.stderr.write(state.sshFail + '\n'); process.exit(255) }
  if (state.sshHang) { setInterval(() => {}, 1000); return }
  const fwd = args[args.indexOf('-L') + 1]
  const port = Number(fwd.split(':')[1])
  const srv = net.createServer((s) => s.end())
  srv.listen(port, '127.0.0.1')
  process.on('SIGTERM', () => process.exit(0))
} else {
  process.stderr.write('fake-tools: unknown command ' + cmd + '\n')
  process.exit(127)
}
`

/**
 * Install fakes for the given commands by mocking child_process.spawn.
 * @param {import('node:test').MockTracker} mock
 * @param {string} dir  scratch directory
 * @param {string[]} commands  e.g. ['psql', 'pg_dump']
 * @returns {{ setState: (s: object) => void, calls: () => object[] }}
 */
function installFakes(mock, dir, commands) {
  const script = path.join(dir, 'fake-tools-script.js')
  const stateFile = path.join(dir, 'fake-state.json')
  fs.writeFileSync(script, FAKE_SCRIPT)
  fs.writeFileSync(stateFile, '{}')
  mock.method(childProcess, 'spawn', (cmd, args, opts) => {
    if (!commands.includes(cmd)) return realSpawn(cmd, args, opts)
    return realSpawn(process.execPath, [script, stateFile, cmd, ...args], opts)
  })
  return {
    setState(state) {
      fs.writeFileSync(stateFile, JSON.stringify(state))
      fs.rmSync(`${stateFile}.log`, { force: true })
    },
    calls() {
      const log = `${stateFile}.log`
      return fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []
    },
  }
}

module.exports = { installFakes }
