// Test support: a child_process.spawn stand-in that records each call and
// answers with canned stdout, so adapters run without psql, mysql or docker.
// Option files are read during the call because adapters delete them afterwards.
const fs = require('fs')
const childProcess = require('child_process')

const realSpawn = childProcess.spawn

/**
 * @param {import('node:test').MockTracker} mock
 * @param {string[]} commands  commands to fake, e.g. ['docker', 'psql']
 * @returns {{ respond: (fn: (call: object) => string|{ stderr: string, code?: number }) => void, calls: object[] }}
 */
function installSpawnFake(mock, commands) {
  const calls = []
  let responder = () => ''
  mock.method(childProcess, 'spawn', (cmd, args, opts) => {
    if (!commands.includes(cmd)) return realSpawn(cmd, args, opts)
    const optArg = args.find((a) => a.startsWith('--defaults-extra-file='))
    const optionFile = optArg ? fs.readFileSync(optArg.slice(optArg.indexOf('=') + 1), 'utf8') : undefined
    const call = { cmd, args, env: opts?.env, optionFile }
    calls.push(call)
    const answer = responder(call)
    const { stdout = '', stderr = '', code = 0 } = typeof answer === 'string' ? { stdout: answer } : answer
    const script = `process.stdout.write(${JSON.stringify(stdout)}); process.stderr.write(${JSON.stringify(stderr)}); process.exitCode = ${code}`
    return realSpawn(process.execPath, ['-e', script], { ...opts, env: process.env })
  })
  return {
    calls,
    respond(fn) { responder = fn },
  }
}

module.exports = { installSpawnFake }
