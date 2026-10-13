const { setupTestEnv } = require('../test-helpers')
const env = setupTestEnv()

const { test, mock, beforeEach } = require('node:test')
const assert = require('node:assert/strict')
const net = require('net')
const fs = require('fs')
const { installFakes } = require('./fake-tools')
const { withConnection } = require('./tunnel')
const { CONFIG_FILE } = require('./ssh-config')

const fakes = installFakes(mock, env.root, ['ssh'])

const KEY = '-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----\n'
const base = {
  id: 'feed01', name: 'tunneled', kind: 'direct', engine: 'postgres', builtin: false,
  host: 'db.internal', port: 5432, username: 'u', password: 'p', database: 'postgres', sslmode: 'prefer',
}
const tunneled = { ...base, tunnel: { host: 'bastion.example.com', port: 2222, user: 'deploy', privateKey: KEY } }

function canConnect(port) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port })
    s.once('connect', () => { s.destroy(); resolve(true) })
    s.once('error', () => resolve(false))
  })
}

beforeEach(() => fakes.setState({}))

test('without a tunnel the callback gets the server settings directly', async () => {
  const conn = await withConnection({ ...base, tunnel: null }, async (c) => c)
  assert.deepEqual(conn, { host: 'db.internal', port: 5432, username: 'u', password: 'p', database: 'postgres', sslmode: 'prefer' })
  assert.equal(fakes.calls().length, 0)
})

test('opens a local forward, runs the callback against it, then closes it', async () => {
  const logs = []
  let seen
  const result = await withConnection(tunneled, async (conn) => {
    seen = conn
    assert.equal(await canConnect(conn.port), true)
    return 'done'
  }, { log: (l) => logs.push(l) })

  assert.equal(result, 'done')
  assert.equal(seen.host, '127.0.0.1')
  assert.equal(seen.tlsServerName, 'db.internal')
  assert.equal(seen.password, 'p')
  const [call] = fakes.calls()
  assert.deepEqual(call.args.slice(0, 5), ['-F', CONFIG_FILE, '-N', '-o', 'ExitOnForwardFailure=yes'])
  assert.equal(call.args.at(-2), `127.0.0.1:${seen.port}:db.internal:5432`)
  assert.equal(call.args.at(-1), 'pgui-feed01')
  assert.equal(await canConnect(seen.port), false, 'tunnel must be closed afterwards')
  assert.ok(logs.some((l) => l.includes('Tunnel closed')))
})

test('writes the managed config and key before connecting', async () => {
  await withConnection(tunneled, async () => {})
  const config = fs.readFileSync(CONFIG_FILE, 'utf8')
  assert.match(config, /Host pgui-feed01\n {2}HostName bastion\.example\.com\n {2}Port 2222\n {2}User deploy/)
  assert.match(config, /StrictHostKeyChecking accept-new/)
  assert.match(config, /BatchMode yes/)
})

test('closes the tunnel when the callback throws', async () => {
  let port
  await assert.rejects(withConnection(tunneled, async (conn) => {
    port = conn.port
    throw new Error('boom')
  }), /boom/)
  assert.equal(await canConnect(port), false)
})

test('reports ssh errors readably', async () => {
  fakes.setState({ sshFail: 'deploy@bastion.example.com: Permission denied (publickey).' })
  await assert.rejects(withConnection(tunneled, async () => assert.fail('must not run')),
    /SSH tunnel failed: deploy@bastion\.example\.com: Permission denied \(publickey\)\./)
})

test('times out when the forward never opens', async () => {
  fakes.setState({ sshHang: true })
  await assert.rejects(withConnection(tunneled, async () => assert.fail('must not run'), { timeoutMs: 500 }),
    /did not open within/)
})

test('rejects non-direct servers', async () => {
  await assert.rejects(withConnection({ kind: 'docker', name: 'x' }, async () => {}), /not a direct database server/)
})
