const path = require('path')
const { Transform } = require('stream')
const { dumpToFile, restoreFromFile } = require('./stream-tools')

// MySQL / MariaDB driver logic shared by the Docker and direct drivers.
//
// A driver is built from an `open(target, fn, opts)` function that hands
// `fn` a runner:
//   runner.spawn(tool, args)    -> ChildProcess   tool: 'dump' | 'client'
//   runner.capture(tool, args)  -> Promise<string> (stdout; rejects on failure)
// The runner decides where the tools run (docker exec or locally) and how
// credentials reach them (always an option file, never argv).
//
// Dumps cover ONE database without `--databases`, so they contain no
// CREATE DATABASE / USE and can be restored under any name.

const SYSTEM_DATABASES = ['information_schema', 'performance_schema', 'mysql', 'sys']
const DUMP_ARGS = [
  '--single-transaction', '--quick', '--routines', '--triggers', '--events',
  '--hex-blob', '--no-tablespaces', '--default-character-set=utf8mb4',
]
const SQL_ERROR_RE = /^ERROR(\s+\d+|\s+at line|:)/

/** Quote a MySQL identifier. */
function quoteIdent(name) {
  return `\`${String(name).replace(/`/g, '``')}\``
}

/** Quote a MySQL string literal. */
function quoteLiteral(value) {
  return `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "''")}'`
}

// Lines removed while restoring so a dump made with `--databases` (or by the
// MariaDB 11 dump tool) still lands in the chosen target database.
const DB_LINE_RE = /^(?:CREATE DATABASE (?:\/\*!32312 IF NOT EXISTS\*\/ )?`((?:[^`]|``)+)`.*;|USE `((?:[^`]|``)+)`;)\s*$/
const SANDBOX_LINE_RE = /^\/\*M?!999999\\- enable the sandbox mode \*\/\s*$/
const CANDIDATE_START = new Set([0x43, 0x55, 0x2f]) // C, U, /
const MAX_CHECKED_LINE = 4096

/** True when a line should be dropped; tracks database names seen. */
function checkLine(line, seen) {
  if (SANDBOX_LINE_RE.test(line)) return true
  const m = line.match(DB_LINE_RE)
  if (!m) return false
  seen.add((m[1] || m[2]).replace(/``/g, '`'))
  if (seen.size > 1) throw new Error(`The dump contains several databases (${[...seen].join(', ')}) – restore them one at a time.`)
  return true
}

/**
 * Transform that drops top-level CREATE DATABASE / USE statements (and the
 * MariaDB sandbox marker) so the dump restores into the database the client
 * was started with. Works on bytes: only short lines starting with C, U or /
 * are held back and decoded; everything else streams straight through, so
 * huge INSERT lines cost no extra copies.
 */
function retargetTransform() {
  const seen = new Set()
  let held = null // start of a line that might be dropped
  let passing = false // inside a line that is known to be kept
  const drop = (buf) => checkLine(buf.toString('utf8').replace(/\r?\n$/, ''), seen)

  function scan(chunk) {
    const out = []
    let i = 0
    while (i < chunk.length) {
      const nl = chunk.indexOf(0x0a, i)
      const end = nl === -1 ? chunk.length : nl + 1
      if (!passing && held === null && !CANDIDATE_START.has(chunk[i])) passing = true
      if (passing) {
        out.push(chunk.subarray(i, end))
        passing = nl === -1
      } else {
        held = held ? Buffer.concat([held, chunk.subarray(i, end)]) : chunk.subarray(i, end)
        if (nl !== -1) {
          if (!drop(held)) out.push(held)
          held = null
        } else if (held.length >= MAX_CHECKED_LINE) {
          out.push(held)
          held = null
          passing = true
        }
      }
      i = end
    }
    return out.length === 1 ? out[0] : Buffer.concat(out)
  }

  return new Transform({
    transform(chunk, enc, cb) {
      try {
        const out = scan(chunk)
        if (out.length) this.push(out)
        cb()
      } catch (err) { cb(err) }
    },
    flush(cb) {
      try {
        if (held && !drop(held)) this.push(held)
        cb()
      } catch (err) { cb(err) }
    },
  })
}

/** Run one statement and return its tab-separated output (no headers). */
async function query(runner, sql, database) {
  const out = await runner.capture('client', ['-N', '-B', '-e', sql, ...(database ? [database] : [])])
  return out.trim()
}

async function exec(job, runner, sql) {
  const out = await query(runner, sql)
  if (out) job.log(out)
}

async function databaseExists(runner, database) {
  const n = await query(runner, `SELECT COUNT(*) FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ${quoteLiteral(database)};`)
  return Number(n) > 0
}

/** Tables/views + routines + events: a database with any of them is not empty. */
function countTables(runner, database) {
  const db = quoteLiteral(database)
  return query(runner, `SELECT (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = ${db})
    + (SELECT COUNT(*) FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ${db})
    + (SELECT COUNT(*) FROM information_schema.EVENTS WHERE EVENT_SCHEMA = ${db});`).then(Number)
}

/** Drop/create the target and refuse to merge into a database that has tables. */
async function prepareTarget(job, runner, database, dropExisting) {
  if (dropExisting) {
    job.log(`[mysql-restore] Dropping existing database '${database}' (if any)...`)
    await exec(job, runner, `DROP DATABASE IF EXISTS ${quoteIdent(database)};`)
  }
  if (!(await databaseExists(runner, database))) {
    job.log(`[mysql-restore] Creating database '${database}'...`)
    await exec(job, runner, `CREATE DATABASE ${quoteIdent(database)};`)
    return
  }
  const tables = await countTables(runner, database)
  if (tables > 0) {
    job.log(`[mysql-restore] ERROR: Database '${database}' already exists and contains ${tables} table(s).`, 'stderr')
    throw new Error("Enable 'Drop target database before restore' or choose another target name.")
  }
  job.log(`[mysql-restore] Database '${database}' exists and is empty – restoring into it.`)
}

/** KILL every other connection using `database`. */
async function killConnections(job, runner, database) {
  const ids = (await query(runner,
    `SELECT ID FROM information_schema.PROCESSLIST WHERE DB = ${quoteLiteral(database)} AND ID <> CONNECTION_ID();`))
    .split('\n').map((l) => l.trim()).filter((l) => /^\d+$/.test(l))
  for (const id of ids) {
    try {
      await query(runner, `KILL ${id};`)
      job.log(`[mysql-unblock] Killed connection ${id}`)
    } catch (err) {
      // The connection may have ended in the meantime
      if (!/Unknown thread id/i.test(err.message)) throw err
    }
  }
  job.log(`[mysql-unblock] ${ids.length} connection(s) terminated.`)
}

function countSqlErrors(line) {
  return SQL_ERROR_RE.test(line) ? 1 : 0
}

/**
 * Build a MySQL driver.
 * @param {{ kind: string, open: (target: object, fn: (runner: object) => Promise<any>, opts?: object) => Promise<any> }} spec
 */
function createMysqlDriver({ kind, open }) {
  const connect = (job, target, fn) => open(target, fn, { log: (l) => job.log(l) })
  const where = (target) => `${target.server.name}${target.container ? ` / ${target.container}` : ''}`

  return {
    engine: 'mysql',
    kind,
    label: 'MySQL / MariaDB',
    fileExtension: '.sql',

    listDatabases(target) {
      return open(target, async (runner) => (await query(runner, 'SHOW DATABASES;'))
        .split('\n').map((l) => l.trim()).filter((d) => d && !SYSTEM_DATABASES.includes(d)))
    },

    dump(job, target, { database, outFile }) {
      return connect(job, target, async (runner) => {
        job.log(`[mysql-export] Exporting database '${database}' from ${where(target)}...`)
        await dumpToFile(job, runner.spawn('dump', [...DUMP_ARGS, database]), outFile, 'mysqldump')
        job.log(`[mysql-export] Done. Dump saved to: ${outFile}`)
      })
    },

    restore(job, target, { database, inFile, dropExisting }) {
      return connect(job, target, async (runner) => {
        await prepareTarget(job, runner, database, dropExisting)
        job.log(`[mysql-restore] Restoring into '${database}' on ${where(target)} from: ${path.basename(inFile)}`)
        await restoreFromFile(job, runner.spawn('client', [database]), inFile,
          { tool: 'mysql', transform: retargetTransform(), countErrors: countSqlErrors })
        job.log('[mysql-restore] Done. Restore completed without errors.')
      })
    },

    create(job, target, { database }) {
      return connect(job, target, async (runner) => {
        job.log(`[mysql-create] Creating database '${database}' on ${where(target)}...`)
        await exec(job, runner, `CREATE DATABASE ${quoteIdent(database)};`)
        job.log('[mysql-create] Done.')
      })
    },

    drop(job, target, { database }) {
      return connect(job, target, async (runner) => {
        job.log(`[mysql-delete] Dropping database '${database}' on ${where(target)}...`)
        await exec(job, runner, `DROP DATABASE ${quoteIdent(database)};`)
        job.log('[mysql-delete] Done.')
      })
    },

    unblock(job, target, { database }) {
      return connect(job, target, async (runner) => {
        job.log(`[mysql-unblock] Terminating all connections to '${database}' on ${where(target)}...`)
        await killConnections(job, runner, database)
      })
    },

    /** Connection check for POST /api/servers/:id/test. */
    testConnection(target) {
      return open(target, async (runner) => ({ version: `MySQL/MariaDB ${await query(runner, 'SELECT VERSION();')}` }))
    },
  }
}

module.exports = {
  createMysqlDriver, retargetTransform, quoteIdent, quoteLiteral, DUMP_ARGS, SYSTEM_DATABASES,
}
