const childProcess = require('child_process')

// Small process helpers for drivers that run client tools in this image.
// Processes are always spawned with argument arrays (never a shell) and get
// credentials through the environment.

const DEFAULT_TIMEOUT_MS = 60000
const MAX_CAPTURE = 16 * 1024 * 1024

/**
 * Run a command and resolve with its stdout. Rejects with stderr as the
 * message when it exits non-zero, fails to start, or times out.
 * @param {string} command
 * @param {string[]} args
 * @param {{ env?: object, timeout?: number }} [opts]
 * @returns {Promise<string>}
 */
function capture(command, args, { env, timeout = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const proc = childProcess.spawn(command, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; proc.kill('SIGKILL') }, timeout)
    proc.stdout.on('data', (d) => { if (stdout.length < MAX_CAPTURE) stdout += d.toString() })
    proc.stderr.on('data', (d) => { if (stderr.length < MAX_CAPTURE) stderr += d.toString() })
    proc.on('error', (err) => { clearTimeout(timer); reject(new Error(`Cannot run ${command}: ${err.message}`)) })
    proc.on('close', (code) => {
      clearTimeout(timer)
      if (timedOut) return reject(new Error(`${command} timed out after ${Math.round(timeout / 1000)}s`))
      if (code === 0) return resolve(stdout)
      reject(new Error(stderr.trim() || `${command} exited with code ${code}`))
    })
  })
}

/**
 * Turn a stream of chunks into complete lines.
 * @param {(line: string) => void} onLine
 * @returns {{ push: (chunk: Buffer|string) => void, flush: () => void }}
 */
function lineReader(onLine) {
  let rest = ''
  return {
    push(chunk) {
      const parts = (rest + chunk.toString()).split('\n')
      rest = parts.pop()
      parts.forEach((l) => onLine(l.replace(/\r$/, '')))
    },
    flush() {
      if (rest) onLine(rest)
      rest = ''
    },
  }
}

/** Resolve with the exit code once a process has closed. */
function exitCode(proc) {
  return new Promise((resolve, reject) => {
    proc.on('error', reject)
    proc.on('close', (code) => resolve(code))
  })
}

module.exports = { capture, lineReader, exitCode }
