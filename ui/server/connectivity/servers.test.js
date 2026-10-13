const { setupTestEnv, startTestServer } = require('../test-helpers')
const env = setupTestEnv()

const { test, before, after, mock } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const express = require('express')
const { getDb } = require('../db')
const servers = require('../servers')
const dockerCli = require('../docker')
const { installFakes } = require('./fake-tools')
const { CONFIG_FILE, KNOWN_HOSTS, BIN_DIR, keyFile } = require('./ssh-config')

const fakes = installFakes(mock, env.root, ['psql'])

const KEY = '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ==\n-----END OPENSSH PRIVATE KEY-----'
// openssh-key-v1 with cipher "aes256-ctr" → passphrase protected
const ENCRYPTED_KEY = '-----BEGIN OPENSSH PRIVATE KEY-----\n' +
  Buffer.concat([Buffer.from('openssh-key-v1\0'), Buffer.from([0, 0, 0, 10]), Buffer.from('aes256-ctr')]).toString('base64') +
  '\n-----END OPENSSH PRIVATE KEY-----'

const dockerBody = { name: 'Remote docker', kind: 'docker', ssh: { host: 'docker.example.com', user: 'deploy', privateKey: KEY } }
const directBody = {
  name: 'Prod DB', kind: 'direct', host: 'db.example.com', port: 5433, username: 'backup',
  password: 'db-pass-123', database: 'postgres', sslmode: 'require',
}

let srv
before(async () => { srv = await startTestServer() })
after(() => srv.close())

async function create(body) {
  const res = await srv.request('POST', '/api/servers', { body })
  assert.equal(res.status, 201, res.text)
  return res.json
}

test('lists the built-in local server', async () => {
  const res = await srv.request('GET', '/api/servers')
  assert.equal(res.status, 200)
  assert.deepEqual(res.json[0], { ...servers.LOCAL_SERVER })
})

test('creates a remote Docker server without exposing the key', async () => {
  const created = await create(dockerBody)
  assert.equal(created.kind, 'docker')
  assert.deepEqual(created.ssh, { host: 'docker.example.com', port: 22, user: 'deploy', keyConfigured: true })
  assert.deepEqual(created.hostKeys, [])

  const list = await srv.request('GET', '/api/servers')
  assert.ok(!list.text.includes('PRIVATE KEY'))
  assert.ok(list.json.some((s) => s.id === created.id))

  // Encrypted at rest
  const row = getDb().prepare('SELECT * FROM servers WHERE id = ?').get(created.id)
  assert.ok(!row.secrets.includes('PRIVATE'))
  assert.equal(servers.getServer(created.id).ssh.privateKey, `${KEY}\n`)
})

test('generates the managed ssh config, key file and wrapper', async () => {
  const created = await create({ ...dockerBody, name: 'cfg', ssh: { ...dockerBody.ssh, host: '10.0.0.5', port: 2200 } })
  const config = fs.readFileSync(CONFIG_FILE, 'utf8')
  assert.match(config, new RegExp(`Host pgui-${created.id}\\n {2}HostName 10\\.0\\.0\\.5\\n {2}Port 2200\\n {2}User deploy`))
  assert.match(config, new RegExp(`HostKeyAlias pgui-${created.id}`))
  assert.match(config, /IdentitiesOnly yes/)
  assert.equal(fs.readFileSync(keyFile(created.id), 'utf8'), `${KEY}\n`)
  assert.match(fs.readFileSync(path.join(BIN_DIR, 'ssh'), 'utf8'), /-F '.*config' "\$@"/)

  const execEnv = await servers.execEnv(servers.getServer(created.id))
  assert.equal(execEnv.DOCKER_HOST, `ssh://pgui-${created.id}`)
  assert.ok(execEnv.PATH.startsWith(BIN_DIR + path.delimiter))
  assert.deepEqual(await servers.execEnv(servers.LOCAL_SERVER), {})

  await srv.request('DELETE', `/api/servers/${created.id}`)
  assert.equal(fs.existsSync(keyFile(created.id)), false)
  assert.ok(!fs.readFileSync(CONFIG_FILE, 'utf8').includes(`pgui-${created.id}`))
})

test('creates a direct server with masked password and optional tunnel', async () => {
  const created = await create({ ...directBody, tunnel: { enabled: true, host: 'bastion.example.com', user: 'jump', privateKey: KEY } })
  assert.equal(created.passwordConfigured, true)
  assert.equal(created.password, undefined)
  assert.equal(created.engine, 'postgres')
  assert.deepEqual(created.tunnel, { host: 'bastion.example.com', port: 22, user: 'jump', keyConfigured: true })
  const res = await srv.request('GET', `/api/servers/${created.id}`)
  assert.ok(!res.text.includes('db-pass-123'))
  assert.ok(!res.text.includes('PRIVATE KEY'))
})

test('update keeps secrets when the fields are empty', async () => {
  const created = await create(directBody)
  const res = await srv.request('PUT', `/api/servers/${created.id}`, { body: { ...directBody, name: 'Renamed', password: '' } })
  assert.equal(res.status, 200, res.text)
  assert.equal(res.json.name, 'Renamed')
  assert.equal(servers.getServer(created.id).password, 'db-pass-123')

  await srv.request('PUT', `/api/servers/${created.id}`, { body: { ...directBody, password: 'new-pass' } })
  assert.equal(servers.getServer(created.id).password, 'new-pass')

  const kind = await srv.request('PUT', `/api/servers/${created.id}`, { body: { ...dockerBody } })
  assert.equal(kind.status, 400)
})

test('validates input', async () => {
  const cases = [
    { ...dockerBody, ssh: { ...dockerBody.ssh, host: 'evil\n  ProxyCommand x' } },
    { ...dockerBody, ssh: { ...dockerBody.ssh, host: '-oProxyCommand=x' } },
    { ...dockerBody, ssh: { ...dockerBody.ssh, user: 'a b' } },
    { ...dockerBody, ssh: { ...dockerBody.ssh, port: 70000 } },
    { ...dockerBody, ssh: { ...dockerBody.ssh, privateKey: '' } },
    { ...dockerBody, ssh: { ...dockerBody.ssh, privateKey: 'not a key' } },
    { ...dockerBody, ssh: { ...dockerBody.ssh, privateKey: ENCRYPTED_KEY } },
    { ...dockerBody, name: '' },
    { ...directBody, sslmode: 'allow-anything' },
    { ...directBody, engine: 'oracle' },
    { ...directBody, database: 'bad name' },
    { ...directBody, host: '' },
    { ...directBody, tunnel: { host: 'bastion', user: 'jump' } },
    { ...directBody, kind: 'ftp' },
  ]
  for (const body of cases) {
    const res = await srv.request('POST', '/api/servers', { body })
    assert.equal(res.status, 400, JSON.stringify(body))
  }
  const enc = await srv.request('POST', '/api/servers', { body: cases[6] })
  assert.match(enc.json.error, /Passphrase-protected/)
})

test('the local server cannot be edited or deleted; unknown ids are 404', async () => {
  assert.equal((await srv.request('PUT', '/api/servers/local', { body: dockerBody })).status, 400)
  assert.equal((await srv.request('DELETE', '/api/servers/local')).status, 400)
  assert.equal((await srv.request('GET', '/api/servers/nope')).status, 404)
  assert.equal((await srv.request('DELETE', '/api/servers/nope')).status, 404)
})

test('exposes and forgets the trusted host key', async () => {
  const created = await create(dockerBody)
  const blob = crypto.randomBytes(51).toString('base64')
  fs.writeFileSync(KNOWN_HOSTS, `other ssh-ed25519 AAAA\npgui-${created.id} ssh-ed25519 ${blob}\n`)

  const res = await srv.request('GET', `/api/servers/${created.id}`)
  const expected = 'SHA256:' + crypto.createHash('sha256').update(Buffer.from(blob, 'base64')).digest('base64').replace(/=+$/, '')
  assert.deepEqual(res.json.hostKeys, [{ type: 'ssh-ed25519', fingerprint: expected }])

  const del = await srv.request('DELETE', `/api/servers/${created.id}/host-key`)
  assert.deepEqual(del.json, { ok: true, removed: 1 })
  assert.equal(fs.readFileSync(KNOWN_HOSTS, 'utf8').trim(), 'other ssh-ed25519 AAAA')
})

test('changing the SSH host forgets its host key', async () => {
  const created = await create(dockerBody)
  fs.appendFileSync(KNOWN_HOSTS, `pgui-${created.id} ssh-ed25519 AAAA\n`)
  await srv.request('PUT', `/api/servers/${created.id}`, { body: { ...dockerBody, ssh: { ...dockerBody.ssh, privateKey: '' } } })
  assert.equal((await srv.request('GET', `/api/servers/${created.id}`)).json.hostKeys.length, 1, 'same host keeps the key')
  await srv.request('PUT', `/api/servers/${created.id}`, { body: { ...dockerBody, ssh: { ...dockerBody.ssh, host: 'new.example.com', privateKey: '' } } })
  assert.equal((await srv.request('GET', `/api/servers/${created.id}`)).json.hostKeys.length, 0)
})

test('tests a Docker server through its environment', async (t) => {
  const created = await create(dockerBody)
  const calls = []
  t.mock.method(dockerCli, 'docker', async (args, { env: e }) => {
    calls.push({ args, env: e })
    return args[0] === 'version' ? '27.3.1\n' : 'abc\ndef\n'
  })
  const res = await srv.request('POST', `/api/servers/${created.id}/test`)
  assert.equal(res.json.ok, true, res.text)
  assert.equal(res.json.version, 'Docker 27.3.1')
  assert.equal(res.json.details, '2 running container(s)')
  assert.equal(typeof res.json.latencyMs, 'number')
  assert.equal(calls[0].env.DOCKER_HOST, `ssh://pgui-${created.id}`)

  t.mock.method(dockerCli, 'docker', async () => { throw new Error('Cannot connect to the Docker daemon') })
  const failed = await srv.request('POST', `/api/servers/${created.id}/test`)
  assert.deepEqual([failed.json.ok, failed.json.error], [false, 'Cannot connect to the Docker daemon'])
})

test('tests a direct server and lists its databases', async () => {
  const created = await create(directBody)
  fakes.setState({ existing: ['app', 'postgres'] })
  const res = await srv.request('POST', `/api/servers/${created.id}/test`)
  assert.equal(res.json.ok, true, res.text)
  assert.equal(res.json.version, 'PostgreSQL 18.0 (fake)')

  const dbs = await srv.request('GET', `/api/servers/${created.id}/databases`)
  assert.deepEqual(dbs.json, ['app', 'postgres'])
  assert.equal((await srv.request('GET', '/api/servers/local/databases')).status, 400)
  assert.equal((await srv.request('GET', `/api/containers?serverId=${created.id}`)).status, 400)
})

test('requires authentication', async () => {
  assert.equal((await srv.request('GET', '/api/servers', { noAuth: true })).status, 401)
})

test('non-admin users can read but not change servers', async () => {
  const { router } = require('./routes')
  const app = express()
  app.use(express.json())
  app.use((req, res, next) => { req.user = { id: 2, username: 'viewer', role: 'user' }; next() })
  app.use('/api', router)
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
  const url = `http://127.0.0.1:${server.address().port}/api`
  const created = await create(directBody)
  try {
    assert.equal((await fetch(`${url}/servers`)).status, 200)
    const post = await fetch(`${url}/servers`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(directBody) })
    assert.equal(post.status, 403)
    for (const [method, p] of [['PUT', ''], ['DELETE', ''], ['POST', '/test'], ['DELETE', '/host-key']]) {
      assert.equal((await fetch(`${url}/servers/${created.id}${p}`, { method })).status, 403, `${method} ${p}`)
    }
  } finally {
    await new Promise((r) => server.close(r))
  }
})
