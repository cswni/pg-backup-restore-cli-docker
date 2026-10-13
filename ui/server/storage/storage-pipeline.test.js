const { setupTestEnv } = require('../test-helpers')
const env = setupTestEnv()
delete process.env.BACKUP_ENCRYPTION_PASSPHRASE

const { test, before, after, beforeEach } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const jobs = require('../jobs')
const catalog = require('../catalog')
const settings = require('../settings')
const pipeline = require('../pipeline')
const { registerDriver } = require('../drivers')
const { LOCAL_SERVER } = require('../servers')
const storage = require('./index')
const config = require('./config')
const destinations = require('./destinations')
const { startFakeS3 } = require('./test-fakes')

const DUMP = 'CREATE TABLE t (id int);\n'.repeat(2000)
const restored = []
registerDriver({
  engine: 'fake',
  kind: 'docker',
  label: 'Fake',
  fileExtension: '.sql',
  async listDatabases() { return [] },
  async dump(job, target, { outFile }) { fs.writeFileSync(outFile, DUMP) },
  async restore(job, target, { database, inFile }) { restored.push({ database, content: fs.readFileSync(inFile, 'utf8') }) },
})

let s3
before(async () => {
  jobs.init(); catalog.init(); settings.init(); storage.init()
  s3 = await startFakeS3()
})
after(() => s3.close())
beforeEach(() => {
  config.saveSettings({ compression: { enabled: true, level: 6 }, encryption: { enabled: false }, upload: { failurePolicy: 'fail' } })
  s3.state.failPuts = false
  for (const d of destinations.listDestinations()) destinations.deleteDestination(d.id)
})

/** Run work in a job; resolves with { result, job } or rejects with the error. */
function runInJob(work) {
  return new Promise((resolve, reject) => {
    jobs.startJob('test', {}, async (job) => {
      try { resolve({ result: await work(job), job }) } catch (err) { reject(Object.assign(err, { job })); throw err }
    })
  })
}

// Unique database per backup: file names only have second resolution
let seq = 0
const backup = (options, database = `premas${++seq}`) => runInJob((job) => pipeline.runBackup(job, {
  server: LOCAL_SERVER, container: 'c1', engine: 'fake', database, options,
})).then(({ result, job }) => ({ ctx: result, job, name: path.basename(result.file) }))

const restore = (file) => runInJob((job) => pipeline.runRestore(job, {
  server: LOCAL_SERVER, container: 'c1', engine: 'fake', database: 'target', file,
}))

function addS3(extra = {}) {
  return destinations.insertDestination({
    type: 's3',
    name: extra.name || 'fake-s3',
    isDefault: !!extra.isDefault,
    config: {
      endpoint: s3.url, region: 'us-east-1', bucket: 'bkt', prefix: 'pg/',
      accessKeyId: 'AKIDTEST', secretAccessKey: 'secret', forcePathStyle: true,
    },
  })
}

const tmpFiles = () => fs.readdirSync(path.join(env.DATA_DIR, 'tmp'))

test('compresses by default and decompresses on restore', async () => {
  const { name, ctx } = await backup()
  assert.match(name, /^premas\d+_.*\.sql\.gz$/)
  assert.equal(ctx.compressed, true)
  assert.equal(fs.existsSync(path.join(env.BACKUPS_DIR, name.replace(/\.gz$/, ''))), false, 'raw dump removed')
  const entry = catalog.listBackups().find((b) => b.name === name)
  assert.equal(entry.compressed, true)
  assert.equal(entry.local, true)

  await restore(name)
  assert.equal(restored.at(-1).content, DUMP)
  assert.deepEqual(tmpFiles(), [], 'temporary files cleaned up')
})

test('options.compress=false keeps a plain dump', async () => {
  const { name } = await backup({ compress: false })
  assert.match(name, /\.sql$/)
})

test('rejects invalid options', async () => {
  await assert.rejects(backup({ compress: 'yes' }), /options.compress must be a boolean/)
  await assert.rejects(backup({ destinations: 'all' }), /must be an array/)
  await assert.rejects(backup({ destinations: ['nope'] }), /Unknown destination/)
})

test('encrypts when requested and restores with the passphrase', async () => {
  await assert.rejects(backup({ encrypt: true }), /no passphrase is configured/)

  config.saveSettings({ encryption: { passphrase: 'a very long passphrase' } })
  const { name, ctx } = await backup({ encrypt: true })
  assert.match(name, /\.sql\.gz\.enc$/)
  assert.equal(ctx.encrypted, true)
  assert.doesNotMatch(fs.readFileSync(path.join(env.BACKUPS_DIR, name)).toString('latin1'), /CREATE TABLE/)

  // Replacing the passphrase keeps old backups restorable
  config.saveSettings({ encryption: { passphrase: 'another long passphrase' } })
  await restore(name)
  assert.equal(restored.at(-1).content, DUMP)
  assert.deepEqual(tmpFiles(), [])
})

test('uploads to selected destinations and restores remote-only backups', async () => {
  const dest = addS3()
  const { name, ctx } = await backup({ destinations: [dest.id] })
  assert.equal(ctx.locations.length, 1)
  assert.equal(ctx.locations[0].key, `pg/${name}`)
  assert.ok(s3.state.objects.has(`bkt/pg/${name}`))

  fs.rmSync(path.join(env.BACKUPS_DIR, name))
  const listed = catalog.listBackups().find((b) => b.name === name)
  assert.equal(listed.local, false)
  assert.equal(listed.locations[0].destinationId, dest.id)

  await restore(name)
  assert.equal(restored.at(-1).content, DUMP)
  assert.deepEqual(tmpFiles(), [])
})

test('refuses a remote copy whose checksum does not match', async () => {
  const dest = addS3()
  const { name } = await backup({ destinations: [dest.id] })
  fs.rmSync(path.join(env.BACKUPS_DIR, name))
  s3.state.objects.set(`bkt/pg/${name}`, Buffer.from('corrupted'))
  await assert.rejects(restore(name), /checksum mismatch/)
  assert.deepEqual(tmpFiles(), [])
})

test('uses default destinations when none are selected', async () => {
  const def = addS3({ name: 'default', isDefault: true })
  addS3({ name: 'other' })
  const { ctx } = await backup()
  assert.deepEqual(ctx.locations.map((l) => l.destinationId), [def.id])
  const none = await backup({ destinations: [] })
  assert.deepEqual(none.ctx.locations, [])
})

test('upload failure fails the job but keeps and catalogs the local backup', async () => {
  const dest = addS3()
  s3.state.failPuts = true
  const err = await backup({ destinations: [dest.id] }).catch((e) => e)
  assert.match(err.message, /Upload failed for: fake-s3/)
  const local = catalog.listBackups().filter((b) => b.jobId === err.job.id)
  assert.equal(local.length, 1)
  assert.equal(local[0].local, true)
  assert.ok(err.job.lines.some((l) => l.text.includes('✗ fake-s3')))
})

test('best-effort upload policy keeps the job successful', async () => {
  const dest = addS3()
  s3.state.failPuts = true
  config.saveSettings({ upload: { failurePolicy: 'best-effort' } })
  const { ctx, job } = await backup({ destinations: [dest.id] })
  assert.deepEqual(ctx.locations, [])
  assert.ok(job.lines.some((l) => l.text.includes('best-effort')))
})

test('catalog accepts storage suffixes for any registered dump type', () => {
  assert.equal(catalog.isBackupFile('db_01-01-2026_10_00_00.sql.gz'), true)
  assert.equal(catalog.isBackupFile('db.sql.gz.enc'), true)
  assert.equal(catalog.isBackupFile('db.sql.enc'), true)
  assert.equal(catalog.isBackupFile('archive.tar.gz'), false)
  assert.equal(catalog.isBackupFile('x.enc'), false)
})
