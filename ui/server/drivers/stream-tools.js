const fs = require('fs')
const path = require('path')
const { lineReader, exitCode } = require('../connectivity/process')

// Streaming helpers shared by the MySQL and MongoDB drivers: a dump process
// writes to a file, a restore process reads from one. Processes are spawned
// by the caller (locally or via `docker exec`), so these helpers only deal
// with pipes, logging and failure handling.

/**
 * Pipe `proc.stdout` into `outFile`. On any failure the partial file is
 * removed and an Error is thrown.
 * @param {object} job   job with log()
 * @param {import('child_process').ChildProcess} proc
 * @param {string} outFile
 * @param {string} tool  name used in error messages
 */
async function dumpToFile(job, proc, outFile, tool) {
  const out = fs.createWriteStream(outFile)
  let writeError = null
  // A write error (disk full…) unpipes the tool, which would then block forever
  const written = new Promise((resolve) => {
    out.on('finish', resolve)
    out.on('error', (err) => { writeError = err; proc.kill('SIGKILL'); resolve() })
  })
  const stderr = lineReader((l) => job.log(l, 'stderr'))
  proc.stdout.pipe(out)
  proc.stderr.on('data', (d) => stderr.push(d))
  try {
    const code = await exitCode(proc).catch((err) => { throw new Error(`Cannot run ${tool}: ${err.message}`) })
    stderr.flush()
    await written
    if (writeError) throw new Error(`Cannot write ${path.basename(outFile)}: ${writeError.message}`)
    if (code !== 0) throw new Error(`${tool} exited with code ${code}`)
  } catch (err) {
    out.destroy()
    fs.rmSync(outFile, { force: true })
    throw err
  }
}

/**
 * Stream `inFile` (optionally through `transform`) into `proc.stdin`.
 * Every output line is logged; `countErrors(line)` returns how many errors
 * a line reports. Throws when the tool exits non-zero, the transform fails,
 * or any error was counted.
 * @param {object} job
 * @param {import('child_process').ChildProcess} proc
 * @param {string} inFile
 * @param {{ tool: string, transform?: import('stream').Transform, countErrors?: (line: string) => number }} opts
 */
async function restoreFromFile(job, proc, inFile, { tool, transform, countErrors = () => 0 }) {
  let errors = 0
  let streamError = null
  const onLine = (stream) => lineReader((l) => { errors += countErrors(l); job.log(l, stream) })
  const out = onLine('stdout')
  const err = onLine('stderr')
  proc.stdout.on('data', (d) => out.push(d))
  proc.stderr.on('data', (d) => err.push(d))
  proc.stdin.on('error', () => {}) // EPIPE when the tool dies early: reported via its exit code

  const fail = (e) => { streamError = streamError || e; proc.stdin.destroy(); proc.kill('SIGKILL') }
  const input = fs.createReadStream(inFile).on('error', fail)
  if (transform) {
    transform.on('error', fail)
    input.pipe(transform).pipe(proc.stdin)
  } else {
    input.pipe(proc.stdin)
  }

  const code = await exitCode(proc).catch((e) => { throw new Error(`Cannot run ${tool}: ${e.message}`) })
  out.flush()
  err.flush()
  if (streamError) throw new Error(`Restore aborted: ${streamError.message}`)
  if (code !== 0) throw new Error(`${tool} exited with code ${code}`)
  if (errors > 0) throw new Error(`Restore finished with ${errors} error(s) – see the log above.`)
}

module.exports = { dumpToFile, restoreFromFile }
