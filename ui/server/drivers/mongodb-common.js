const path = require('path')
const { registerBackupPattern } = require('../catalog')
const { dumpToFile, restoreFromFile } = require('./stream-tools')
const { inspectArchive } = require('./mongodb-archive')

// MongoDB driver logic shared by the Docker and direct drivers.
//
// A driver is built from an `open(target, fn, opts)` function that hands
// `fn` a runner:
//   runner.spawn(tool, args)        -> ChildProcess  tool: 'mongodump' | 'mongorestore'
//   runner.listDatabases()          -> Promise<string[]>
//   runner.countCollections(db)     -> Promise<number>  (system.* excluded)
//   runner.dropDatabase(db)         -> Promise<void>
//   runner.version()                -> Promise<string>
//
// Dumps are `mongodump --archive --db <db>`. Restores read the source
// database name from the archive prelude and rename it with
// --nsFrom '<source>.*' --nsTo '<target>.*'. MongoDB has no "CREATE
// DATABASE" (a database exists once it holds data) and no per-database
// connection kill, so create and unblock are not offered.

registerBackupPattern(/\.archive$/i)

const SYSTEM_DATABASES = ['admin', 'config', 'local']
const FAILED_DOCS_RE = /(\d+) document\(s\) failed to restore/
const FAILED_RE = /(^|\t)Failed: /

/** MongoDB forbids these characters in database names ($ is also a namespace-pattern variable). */
function assertMongoName(name) {
  if (/[/\\. "$*<>:|?]/.test(name)) throw new Error(`Invalid MongoDB database name: ${name}`)
}

function countRestoreErrors(line) {
  const docs = line.match(FAILED_DOCS_RE)
  if (docs) return Number(docs[1])
  return FAILED_RE.test(line) ? 1 : 0
}

/** Drop the target when asked; refuse to merge into a database with collections. */
async function prepareTarget(job, runner, database, dropExisting) {
  if (dropExisting) {
    job.log(`[mongo-restore] Dropping existing database '${database}' (if any)...`)
    await runner.dropDatabase(database)
    return
  }
  const collections = await runner.countCollections(database)
  if (collections > 0) {
    job.log(`[mongo-restore] ERROR: Database '${database}' already exists and contains ${collections} collection(s).`, 'stderr')
    throw new Error("Enable 'Drop target database before restore' or choose another target name.")
  }
}

/** Source database of an archive; throws for archives with several databases. */
async function archiveSource(job, inFile) {
  const info = await inspectArchive(inFile)
  if (info.databases.length > 1) {
    throw new Error(`The archive contains several databases (${info.databases.join(', ')}) – only single-database archives can be restored.`)
  }
  const source = info.databases[0] || null
  if (source) assertMongoName(source)
  job.log(`[mongo-restore] Archive source database: ${source || '(none – archive has no collections)'}${info.gzip ? ' (gzip)' : ''}`)
  return { source, gzip: info.gzip }
}

function restoreArgs(source, database, gzip) {
  return [
    '--archive', ...(gzip ? ['--gzip'] : []),
    `--nsInclude=${source}.*`, `--nsFrom=${source}.*`, `--nsTo=${database}.*`,
    '--stopOnError',
  ]
}

/**
 * Build a MongoDB driver.
 * @param {{ kind: string, open: (target: object, fn: (runner: object) => Promise<any>, opts?: object) => Promise<any> }} spec
 */
function createMongoDriver({ kind, open }) {
  const connect = (job, target, fn) => open(target, fn, { log: (l) => job.log(l) })
  const where = (target) => `${target.server.name}${target.container ? ` / ${target.container}` : ''}`

  return {
    engine: 'mongodb',
    kind,
    label: 'MongoDB',
    fileExtension: '.archive',

    listDatabases(target) {
      return open(target, async (runner) => (await runner.listDatabases()).filter((d) => !SYSTEM_DATABASES.includes(d)).sort())
    },

    dump(job, target, { database, outFile }) {
      assertMongoName(database)
      return connect(job, target, async (runner) => {
        job.log(`[mongo-export] Exporting database '${database}' from ${where(target)}...`)
        await dumpToFile(job, runner.spawn('mongodump', ['--archive', `--db=${database}`]), outFile, 'mongodump')
        job.log(`[mongo-export] Done. Archive saved to: ${outFile}`)
      })
    },

    async restore(job, target, { database, inFile, dropExisting }) {
      assertMongoName(database)
      const { source, gzip } = await archiveSource(job, inFile)
      return connect(job, target, async (runner) => {
        await prepareTarget(job, runner, database, dropExisting)
        if (!source) {
          job.log('[mongo-restore] Nothing to restore.')
          return
        }
        job.log(`[mongo-restore] Restoring '${source}' as '${database}' on ${where(target)} from: ${path.basename(inFile)}`)
        await restoreFromFile(job, runner.spawn('mongorestore', restoreArgs(source, database, gzip)), inFile,
          { tool: 'mongorestore', countErrors: countRestoreErrors })
        job.log('[mongo-restore] Done. Restore completed without errors.')
      })
    },

    drop(job, target, { database }) {
      assertMongoName(database)
      return connect(job, target, async (runner) => {
        job.log(`[mongo-delete] Dropping database '${database}' on ${where(target)}...`)
        await runner.dropDatabase(database)
        job.log('[mongo-delete] Done.')
      })
    },

    /** Connection check for POST /api/servers/:id/test. */
    testConnection(target) {
      return open(target, async (runner) => ({ version: `MongoDB ${await runner.version()}` }))
    },
  }
}

module.exports = { createMongoDriver, assertMongoName, restoreArgs, countRestoreErrors, SYSTEM_DATABASES }
