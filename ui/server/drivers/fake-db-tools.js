// Test support: stand-ins for docker exec, the MariaDB client tools and the
// MongoDB database tools, so MySQL and MongoDB driver tests run without any
// database. Only used by *.test.js (same approach as connectivity/fake-tools.js).
const fs = require('fs')
const path = require('path')
const childProcess = require('child_process')

const realSpawn = childProcess.spawn

// Executed as: node fake-db-tools-script.js <stateFile> <command> ...args
const FAKE_SCRIPT = String.raw`
const fs = require('fs')
const [stateFile, command, ...argv] = process.argv.slice(2)
const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
let cmd = command
let args = argv
let via = null
let interactive = false
if (cmd === 'docker') {
  // docker exec [-i] <container> sh -c <script> sh <tool> ...args
  interactive = args[1] === '-i'
  const rest = args.slice(interactive ? 2 : 1)
  via = { container: rest[0] }
  cmd = rest[5]
  args = rest.slice(6)
  if (cmd === 'dump') cmd = 'mariadb-dump'
  if (cmd === 'client') cmd = 'mariadb'
}
const optArg = args.find((a) => a.startsWith('--defaults-extra-file=') || a.startsWith('--config='))
const optFile = optArg && optArg.slice(optArg.indexOf('=') + 1)
const options = optFile ? { content: fs.readFileSync(optFile, 'utf8'), mode: fs.statSync(optFile).mode & 0o777 } : undefined
const record = (extra) => fs.appendFileSync(stateFile + '.log', JSON.stringify({ cmd, args, via, interactive, options, ...extra }) + '\n')
const withStdin = (fn) => {
  const chunks = []
  process.stdin.on('data', (d) => chunks.push(d))
  process.stdin.on('end', () => fn(Buffer.concat(chunks)))
}
const fail = (msg, code = 1) => { process.stderr.write(msg + '\n'); process.exit(code) }

function mysqlQuery(sql) {
  record({ sql })
  if (state.failSql && sql.includes(state.failSql)) fail('ERROR 1007 (HY000) at line 1: ' + state.failSql + ' failed')
  const lit = (sql.match(/= '([^']+)'/) || [])[1]
  if (sql === 'SHOW DATABASES;') return console.log(['information_schema', 'mysql', ...(state.existing || []), 'sys'].join('\n'))
  if (/SCHEMATA/.test(sql)) return console.log((state.existing || []).includes(lit) ? '1' : '0')
  if (/information_schema.TABLES/.test(sql)) return console.log(String((state.tables || {})[lit] || 0))
  if (/PROCESSLIST/.test(sql)) return console.log((state.processlist || []).join('\n'))
  if (/^KILL (\d+)/.test(sql) && (state.goneThreads || []).includes(Number(sql.match(/\d+/)[0]))) fail('ERROR 1094 (HY000) at line 1: Unknown thread id: ' + sql)
  if (sql === 'SELECT VERSION();') return console.log('8.4.2')
}

function mongoShell() {
  const [, action, db] = args
  record({ action, db })
  if (state.shellFail) fail(state.shellFail)
  const results = {
    list: ['admin', 'config', 'local', ...(state.existing || [])],
    count: (state.collections || {})[db] || 0,
    drop: true,
    version: '8.0.4',
  }
  console.log('Current Mongosh Log ID: x')
  console.log(JSON.stringify({ result: results[action] }))
}

if (cmd === 'mariadb' && args.includes('-e')) {
  mysqlQuery(args[args.indexOf('-e') + 1])
} else if (cmd === 'mariadb') {
  withStdin((buf) => {
    record({ stdin: buf.toString() })
    process.stdout.write('')
    if (state.restoreStderr) process.stderr.write(state.restoreStderr)
    process.exitCode = state.restoreExit || 0
  })
} else if (cmd === 'mariadb-dump' || cmd === 'mongodump') {
  if (args.includes('--version')) { record({}); console.log('mongodump version: 100.10.0'); process.exit(0) }
  record({})
  process.stdout.write(state.dumpBase64 ? Buffer.from(state.dumpBase64, 'base64') : (state.dump || ''))
  if (state.dumpStderr) process.stderr.write(state.dumpStderr)
  process.exitCode = state.dumpExit || 0
} else if (cmd === 'mongorestore') {
  withStdin((buf) => {
    record({ stdinBase64: buf.toString('base64') })
    process.stderr.write(state.restoreStderr || '2026-01-01T00:00:00.000+0000\t3 document(s) restored successfully. 0 document(s) failed to restore.\n')
    process.exitCode = state.restoreExit || 0
  })
} else if (cmd === 'shell') {
  mongoShell()
} else {
  fail('fake-db-tools: unknown command ' + cmd, 127)
}
`

/**
 * Install fakes for the given commands by mocking child_process.spawn.
 * @param {import('node:test').MockTracker} mock
 * @param {string} dir  scratch directory
 * @param {string[]} commands  e.g. ['docker', 'mariadb', 'mariadb-dump']
 * @returns {{ setState: (s: object) => void, calls: () => object[] }}
 */
function installDbFakes(mock, dir, commands) {
  const script = path.join(dir, 'fake-db-tools-script.js')
  const stateFile = path.join(dir, 'fake-db-state.json')
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

/** Fake test job collecting log lines. */
function fakeJob() {
  const lines = []
  return { lines, log: (text, stream = 'stdout') => lines.push({ text: String(text), stream }) }
}

module.exports = { installDbFakes, fakeJob }
