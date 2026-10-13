const fs = require('fs')
const path = require('path')
const childProcess = require('child_process')
const { SCRIPTS_DIR } = require('../config')
const { withConnection } = require('../connectivity/tunnel')
const { capture, lineReader, exitCode } = require('../connectivity/process')

// PostgreSQL reached directly over TCP (optionally through an SSH tunnel).
// The client tools (psql, pg_dump) run inside this image. Semantics match
// the Docker scripts (pg-export.sh / pg-restore.sh …): dumps are `pg_dump -C`,
// restores are retargeted with the shared scripts/pg-retarget.awk.

const CONNECT_TIMEOUT_S = '10'
const SQL_ERROR_RE = /^(psql:[^:]*:\d+: )?ERROR:/

/** Quote an SQL identifier. */
function quoteIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`
}

/** Quote an SQL string literal. */
function quoteLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`
}

/**
 * libpq environment for a connection from withConnection(). The password
 * goes in PGPASSWORD, never on the command line. Through a tunnel PGHOSTADDR
 * points at the local end while PGHOST keeps the real name for TLS checks.
 */
function pgEnv(conn) {
  const env = {
    PGHOST: conn.tlsServerName || conn.host,
    PGPORT: String(conn.port),
    PGUSER: conn.username,
    PGSSLMODE: conn.sslmode || 'prefer',
    PGCONNECT_TIMEOUT: CONNECT_TIMEOUT_S,
    PGAPPNAME: 'pg-backup-ui',
  }
  if (conn.tlsServerName) env.PGHOSTADDR = conn.host
  if (conn.password) env.PGPASSWORD = conn.password
  return env
}

function adminDb(conn) {
  return conn.database || 'postgres'
}

/** Run one statement and return trimmed tuples-only output. */
async function query(conn, database, sql) {
  const out = await capture('psql', ['-X', '-w', '-q', '-tA', '-v', 'ON_ERROR_STOP=1', '-d', database, '-c', sql], { env: pgEnv(conn) })
  return out.trim()
}

/** Run a statement as part of a job, logging what happens. */
async function exec(job, conn, database, sql) {
  const out = await query(conn, database, sql)
  if (out) job.log(out)
  return out
}

function countUserTables(conn, database) {
  return query(conn, database, `SELECT count(*) FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r', 'p')
      AND n.nspname NOT IN ('pg_catalog', 'information_schema')
      AND n.nspname NOT LIKE 'pg_toast%';`).then(Number)
}

async function databaseExists(conn, database) {
  return (await query(conn, adminDb(conn), `SELECT 1 FROM pg_database WHERE datname = ${quoteLiteral(database)};`)) === '1'
}

/** Stream `pg_dump -C` into outFile; removes the partial file on failure. */
async function dumpTo(job, conn, database, outFile) {
  const proc = childProcess.spawn('pg_dump', ['-w', '-C', '-d', database], { env: { ...process.env, ...pgEnv(conn) } })
  const out = fs.createWriteStream(outFile)
  const written = new Promise((resolve, reject) => { out.on('finish', resolve); out.on('error', reject) })
  const stderr = lineReader((l) => job.log(l, 'stderr'))
  proc.stdout.pipe(out)
  proc.stderr.on('data', (d) => stderr.push(d))
  const code = await exitCode(proc).catch((err) => { out.destroy(); throw new Error(`Cannot run pg_dump: ${err.message}`) })
  stderr.flush()
  await written.catch(() => {})
  if (code !== 0) {
    fs.rmSync(outFile, { force: true })
    throw new Error(`pg_dump exited with code ${code}`)
  }
}

/**
 * awk (retarget) | psql into `database`. psql keeps going after SQL errors,
 * so stderr is scanned and the restore fails if any ERROR: was reported.
 */
async function pipeRestore(job, conn, database, inFile) {
  const awkFile = path.join(SCRIPTS_DIR, 'pg-retarget.awk')
  if (!fs.existsSync(awkFile)) throw new Error(`${awkFile} not found`)
  const awk = childProcess.spawn('awk', ['-v', `qtarget=${quoteIdent(database)}`, '-f', awkFile])
  const psql = childProcess.spawn('psql', ['-X', '-w', '-d', database], { env: { ...process.env, ...pgEnv(conn) } })
  let errors = 0
  const out = lineReader((l) => job.log(l, 'stdout'))
  const err = lineReader((l) => { if (SQL_ERROR_RE.test(l)) errors += 1; job.log(l, 'stderr') })
  const awkErr = lineReader((l) => job.log(`[awk] ${l}`, 'stderr'))

  fs.createReadStream(inFile).on('error', (e) => awk.stdin.destroy(e)).pipe(awk.stdin)
  awk.stdin.on('error', () => {}) // EPIPE when awk dies early: reported via its exit code
  psql.stdin.on('error', () => {})
  awk.stdout.pipe(psql.stdin)
  awk.stderr.on('data', (d) => awkErr.push(d))
  psql.stdout.on('data', (d) => out.push(d))
  psql.stderr.on('data', (d) => err.push(d))

  const [awkCode, psqlCode] = await Promise.all([exitCode(awk), exitCode(psql)])
  out.flush(); err.flush(); awkErr.flush()
  if (awkCode !== 0) throw new Error(`Retargeting the dump failed (awk exited with code ${awkCode})`)
  if (psqlCode !== 0) throw new Error(`psql exited with code ${psqlCode}`)
  if (errors > 0) throw new Error(`[pg-restore] FAILED: restore finished with ${errors} SQL error(s) – see the log above.`)
}

/** Drop/create the target like pg-restore.sh and refuse to merge into existing tables. */
async function prepareTarget(job, conn, database, dropExisting) {
  if (dropExisting) {
    job.log(`[pg-restore] Dropping existing database '${database}' (if any)...`)
    await exec(job, conn, adminDb(conn), `DROP DATABASE IF EXISTS ${quoteIdent(database)} WITH (FORCE);`)
  }
  if (!(await databaseExists(conn, database))) {
    job.log(`[pg-restore] Creating database '${database}'...`)
    await exec(job, conn, adminDb(conn), `CREATE DATABASE ${quoteIdent(database)};`)
    return
  }
  const tables = await countUserTables(conn, database)
  if (tables > 0) {
    job.log(`[pg-restore] ERROR: Database '${database}' already exists and contains ${tables} table(s).`, 'stderr')
    throw new Error("Enable 'Drop target database before restore' (-x) or choose another target name.")
  }
  job.log(`[pg-restore] Database '${database}' exists and is empty – restoring into it.`)
}

/** withConnection that logs tunnel activity into the job. */
function connect(job, target, fn) {
  return withConnection(target.server, fn, { log: (l) => job.log(l) })
}

module.exports = {
  engine: 'postgres',
  kind: 'direct',
  label: 'PostgreSQL',
  fileExtension: '.sql',

  async listDatabases(target) {
    return withConnection(target.server, async (conn) => {
      const out = await query(conn, adminDb(conn),
        'SELECT datname FROM pg_database WHERE NOT datistemplate AND datallowconn ORDER BY datname;')
      return out.split('\n').map((l) => l.trim()).filter(Boolean)
    })
  },

  dump(job, target, { database, outFile }) {
    return connect(job, target, async (conn) => {
      job.log(`[pg-export] Exporting database '${database}' from ${target.server.name}...`)
      await dumpTo(job, conn, database, outFile)
      job.log(`[pg-export] Done. Dump saved to: ${outFile}`)
    })
  },

  restore(job, target, { database, inFile, dropExisting }) {
    return connect(job, target, async (conn) => {
      await prepareTarget(job, conn, database, dropExisting)
      job.log(`[pg-restore] Restoring into '${database}' on ${target.server.name} from: ${path.basename(inFile)}`)
      await pipeRestore(job, conn, database, inFile)
      job.log('[pg-restore] Done. Restore completed without errors.')
    })
  },

  create(job, target, { database }) {
    return connect(job, target, async (conn) => {
      job.log(`[pg-create] Creating database '${database}' on ${target.server.name}...`)
      await exec(job, conn, adminDb(conn), `CREATE DATABASE ${quoteIdent(database)};`)
      job.log('[pg-create] Done.')
    })
  },

  drop(job, target, { database }) {
    return connect(job, target, async (conn) => {
      job.log(`[pg-delete] Dropping database '${database}' on ${target.server.name}...`)
      await exec(job, conn, adminDb(conn), `DROP DATABASE ${quoteIdent(database)} WITH (FORCE);`)
      job.log('[pg-delete] Done.')
    })
  },

  unblock(job, target, { database }) {
    return connect(job, target, async (conn) => {
      job.log(`[pg-unblock] Terminating all connections to '${database}' on ${target.server.name}...`)
      await exec(job, conn, adminDb(conn),
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = ${quoteLiteral(database)} AND pid <> pg_backend_pid();`)
      job.log('[pg-unblock] Done.')
    })
  },

  /** Connection check for POST /api/servers/:id/test. */
  async testConnection(target) {
    return withConnection(target.server, async (conn) => {
      const version = await query(conn, adminDb(conn), 'SELECT version();')
      return { version }
    })
  },

  // Exposed for tests
  _internals: { quoteIdent, quoteLiteral, pgEnv },
}
