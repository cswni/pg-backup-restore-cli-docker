const { setupTestEnv } = require('./test-helpers')
const env = setupTestEnv()

const { test, before } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const jobs = require('./jobs')
const catalog = require('./catalog')
const { registerDriver } = require('./drivers')
const pipeline = require('./pipeline')
const { LOCAL_SERVER } = require('./servers')

const restored = []
registerDriver({
  engine: 'fake',
  kind: 'docker',
  label: 'Fake',
  fileExtension: '.sql',
  async listDatabases() { return ['a'] },
  async dump(job, target, { database, outFile }) { fs.writeFileSync(outFile, `dump of ${database}`) },
  async restore(job, target, { database, inFile }) { restored.push({ database, content: fs.readFileSync(inFile, 'utf8') }) },
})

before(() => { jobs.init(); catalog.init() })

/** Run work in a job and wait for it to finish. */
function runInJob(work) {
  return new Promise((resolve, reject) => {
    const id = jobs.startJob('test', {}, async (job) => {
      try { resolve(await work(job)) } catch (err) { reject(err); throw err }
    })
    assert.ok(id)
  })
}

test('backup runs the driver, post-backup steps in order, and records the catalog', async () => {
  const order = []
  pipeline.registerPostBackupStep('second', 200, async (ctx) => { order.push('second'); return ctx })
  pipeline.registerPostBackupStep('first', 100, async (ctx) => {
    order.push('first')
    const gz = ctx.file + '.gz'
    fs.renameSync(ctx.file, gz)
    return { ...ctx, file: gz, compressed: true }
  })
  catalog.registerBackupPattern(/\.sql\.gz$/)

  const ctx = await runInJob((job) => pipeline.runBackup(job, {
    server: LOCAL_SERVER, container: 'c1', engine: 'fake', database: 'premas', outputName: 'premas_qa',
  }))

  assert.deepEqual(order, ['first', 'second'])
  const name = path.basename(ctx.file)
  assert.match(name, /^premas_qa_\d{2}-\d{2}-\d{4}_\d{2}_\d{2}_\d{2}\.sql\.gz$/)
  const entry = catalog.listBackups().find((b) => b.name === name)
  assert.equal(entry.sourceDatabase, 'premas')
  assert.equal(entry.compressed, true)
  assert.equal(entry.sha256.length, 64)
})

test('restore runs pre-restore steps and cleans temporary files', async () => {
  fs.writeFileSync(path.join(env.BACKUPS_DIR, 'src.sql'), 'original')
  const tmp = path.join(env.root, 'tmp.sql')
  pipeline.registerPreRestoreStep('transform', 100, async (ctx) => {
    fs.writeFileSync(tmp, 'transformed')
    return { ...ctx, file: tmp, tempFiles: [...ctx.tempFiles, tmp] }
  })

  await runInJob((job) => pipeline.runRestore(job, {
    server: LOCAL_SERVER, container: 'c1', engine: 'fake', database: 'target', file: 'src.sql',
  }))

  assert.deepEqual(restored.at(-1), { database: 'target', content: 'transformed' })
  assert.equal(fs.existsSync(tmp), false)
})

test('restore rejects path traversal in the file name', async () => {
  await assert.rejects(runInJob((job) => pipeline.runRestore(job, {
    server: LOCAL_SERVER, container: 'c1', engine: 'fake', database: 'x', file: '../etc/passwd.sql',
  })), /Invalid backup file name/)
})

test('job history is persisted', () => {
  const list = jobs.listJobs({ type: 'test' })
  assert.ok(list.length >= 2)
  assert.ok(list.every((j) => ['success', 'error'].includes(j.status)))
})
