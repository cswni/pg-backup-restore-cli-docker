const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const zlib = require('zlib')
const crypto = require('crypto')
const { spawnSync } = require('child_process')
const { encryptFile, decryptFile, isEncryptedFile, HEADER_SIZE, TAG_SIZE } = require('./crypto-format')

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pgui-crypto-'))
const file = (name) => path.join(dir, name)
const CLI = path.join(__dirname, 'decrypt-cli.js')

async function roundTrip(data, pass = 'correct horse battery') {
  fs.writeFileSync(file('plain'), data)
  await encryptFile(file('plain'), file('enc'), pass)
  await decryptFile(file('enc'), file('out'), pass)
  return fs.readFileSync(file('out'))
}

test('encrypts and decrypts empty, small and multi-chunk files', async () => {
  for (const data of [Buffer.alloc(0), Buffer.from('SELECT 1;'), crypto.randomBytes(3 * 1024 * 1024 + 7)]) {
    assert.deepEqual(await roundTrip(data), data)
    assert.equal(fs.statSync(file('enc')).size, data.length + HEADER_SIZE + TAG_SIZE)
    assert.equal(isEncryptedFile(file('enc')), true)
  }
  assert.equal(isEncryptedFile(file('plain')), false)
})

test('uses a fresh salt and nonce for every file', async () => {
  fs.writeFileSync(file('p'), 'same content')
  await encryptFile(file('p'), file('e1'), 'passphrase-123')
  await encryptFile(file('p'), file('e2'), 'passphrase-123')
  assert.notDeepEqual(fs.readFileSync(file('e1')).subarray(12, 40), fs.readFileSync(file('e2')).subarray(12, 40))
})

test('rejects a wrong passphrase without writing output', async () => {
  await roundTrip(Buffer.from('secret data'))
  fs.rmSync(file('out2'), { force: true })
  await assert.rejects(decryptFile(file('enc'), file('out2'), 'wrong passphrase'), /Wrong passphrase/)
  assert.equal(fs.existsSync(file('out2')), false)
})

test('tries several passphrases (old ones keep working)', async () => {
  await roundTrip(Buffer.from('rotated'), 'old-passphrase-1')
  await decryptFile(file('enc'), file('out3'), ['new-passphrase-2', 'old-passphrase-1'])
  assert.equal(fs.readFileSync(file('out3'), 'utf8'), 'rotated')
})

test('detects tampering with ciphertext, header and tag', async () => {
  const data = crypto.randomBytes(100000)
  await roundTrip(data)
  const original = fs.readFileSync(file('enc'))
  for (const pos of [HEADER_SIZE + 10, 9, original.length - 1]) {
    const tampered = Buffer.from(original)
    tampered[pos] ^= 0x01
    fs.writeFileSync(file('tampered'), tampered)
    await assert.rejects(decryptFile(file('tampered'), file('out4'), 'correct horse battery'))
    assert.equal(fs.existsSync(file('out4')), false, `output removed after tamper at ${pos}`)
  }
})

test('rejects truncated and non-encrypted input', async () => {
  fs.writeFileSync(file('short'), 'PGBKENC')
  await assert.rejects(decryptFile(file('short'), file('o'), 'x'), /truncated/)
  fs.writeFileSync(file('notenc'), Buffer.alloc(200, 1))
  await assert.rejects(decryptFile(file('notenc'), file('o'), 'x'), /bad magic/)
})

test('offline CLI decrypts with the passphrase from env or stdin, optionally gunzipping', async () => {
  const sql = Buffer.from('CREATE TABLE t (id int);\n'.repeat(500))
  fs.writeFileSync(file('dump.sql.gz'), zlib.gzipSync(sql))
  await encryptFile(file('dump.sql.gz'), file('dump.sql.gz.enc'), 'cli-passphrase-1')

  const env = { ...process.env, BACKUP_ENCRYPTION_PASSPHRASE: 'cli-passphrase-1' }
  const r1 = spawnSync(process.execPath, [CLI, '--gunzip', file('dump.sql.gz.enc'), file('dump.sql')], { env })
  assert.equal(r1.status, 0, r1.stderr.toString())
  assert.deepEqual(fs.readFileSync(file('dump.sql')), sql)

  const noEnv = { ...process.env }
  delete noEnv.BACKUP_ENCRYPTION_PASSPHRASE
  const r2 = spawnSync(process.execPath, [CLI, file('dump.sql.gz.enc'), file('dump2.sql.gz')], { env: noEnv, input: 'cli-passphrase-1\n' })
  assert.equal(r2.status, 0, r2.stderr.toString())
  assert.deepEqual(zlib.gunzipSync(fs.readFileSync(file('dump2.sql.gz'))), sql)

  const r3 = spawnSync(process.execPath, [CLI, file('dump.sql.gz.enc'), file('dump3.sql.gz')], { env: noEnv, input: 'nope' })
  assert.equal(r3.status, 1)
  assert.match(r3.stderr.toString(), /Wrong passphrase/)
  assert.equal(fs.existsSync(file('dump3.sql.gz')), false)

  const r4 = spawnSync(process.execPath, [CLI, file('dump.sql.gz.enc'), file('dump.sql')], { env })
  assert.equal(r4.status, 1)
  assert.match(r4.stderr.toString(), /Refusing to overwrite/)
})

test('rejects headers requesting oversized scrypt parameters (memory DoS)', async () => {
  fs.writeFileSync(file('p-kdf'), 'data')
  await encryptFile(file('p-kdf'), file('e-kdf'), 'passphrase-123')
  const buf = fs.readFileSync(file('e-kdf'))
  buf[9] = 22 // logN = 22 → N = 4M; with r = 8 that is ~4 GiB of scrypt memory
  fs.writeFileSync(file('e-kdf-evil'), buf)
  await assert.rejects(decryptFile(file('e-kdf-evil'), file('o-kdf'), 'passphrase-123'), /Invalid key derivation parameters/)
  assert.equal(fs.existsSync(file('o-kdf')), false)
})
