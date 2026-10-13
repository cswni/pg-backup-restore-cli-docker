const { setupTestEnv, startTestServer, TEST_USER, TEST_PASSWORD } = require('../test-helpers')
const env = setupTestEnv({ PUBLIC_URL: 'https://backup.example.com/' })

const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const gdrive = require('./destinations/gdrive')
const destinations = require('./destinations')
const { startFakeGoogle } = require('./test-fakes')

let srv
let google
let destId
const AUTH = 'Basic ' + Buffer.from(`${TEST_USER}:${TEST_PASSWORD}`).toString('base64')

before(async () => {
  google = await startFakeGoogle()
  gdrive.setEndpointsForTests(google.endpoints)
  srv = await startTestServer()
})
after(async () => { await srv.close(); await google.close() })

/** GET without following redirects. */
function getManual(p, { auth = true } = {}) {
  return fetch(srv.url + p, { redirect: 'manual', headers: auth ? { authorization: AUTH } : {} })
}

const CALLBACK = '/api/storage/gdrive/oauth/callback'

test('creates a Drive destination without exposing the client secret', async () => {
  const res = await srv.request('POST', '/api/storage/destinations', {
    body: { type: 'gdrive', name: 'My Drive', config: { clientId: 'cid.apps.googleusercontent.com', clientSecret: 'secret-1', folderId: 'folder_1' } },
  })
  assert.equal(res.status, 201, res.text)
  assert.doesNotMatch(res.text, /secret-1/)
  assert.deepEqual(res.json.secrets, { clientSecret: true, refreshToken: false })
  destId = res.json.id

  const settings = await srv.request('GET', '/api/storage/settings')
  assert.equal(settings.json.gdriveRedirectUri, `https://backup.example.com${CALLBACK}`)
})

test('connect redirects to Google consent with offline access and a state', async () => {
  const res = await getManual(`/api/storage/gdrive/${destId}/connect`)
  assert.equal(res.status, 302)
  const url = new URL(res.headers.get('location'))
  assert.equal(url.origin + url.pathname, google.endpoints.auth)
  assert.equal(url.searchParams.get('access_type'), 'offline')
  assert.equal(url.searchParams.get('prompt'), 'consent')
  assert.equal(url.searchParams.get('scope'), 'https://www.googleapis.com/auth/drive.file')
  assert.equal(url.searchParams.get('redirect_uri'), `https://backup.example.com${CALLBACK}`)
  assert.ok(url.searchParams.get('state').length >= 40)
})

test('connect requires authentication', async () => {
  const res = await getManual(`/api/storage/gdrive/${destId}/connect`, { auth: false })
  assert.equal(res.status, 401)
})

test('callback rejects unknown state and denied consent', async () => {
  const bad = await getManual(`${CALLBACK}?code=good-code&state=${'x'.repeat(43)}`, { auth: false })
  assert.equal(bad.status, 302)
  assert.equal(bad.headers.get('location'), '/settings/storage?gdrive=error&reason=invalid_state')

  const start = await getManual(`/api/storage/gdrive/${destId}/connect`)
  const state = new URL(start.headers.get('location')).searchParams.get('state')
  const denied = await getManual(`${CALLBACK}?error=access_denied&state=${state}`, { auth: false })
  assert.match(denied.headers.get('location'), /gdrive=error&reason=denied/)
})

test('callback exchanges the code, stores the refresh token and is single-use', async () => {
  const start = await getManual(`/api/storage/gdrive/${destId}/connect`)
  const state = new URL(start.headers.get('location')).searchParams.get('state')
  const res = await getManual(`${CALLBACK}?code=good-code&state=${state}`, { auth: false })
  assert.equal(res.status, 302)
  assert.equal(res.headers.get('location'), `/settings/storage?gdrive=connected&id=${destId}`)
  const exchange = google.state.tokenRequests.find((r) => r.grant_type === 'authorization_code')
  assert.equal(exchange.redirect_uri, `https://backup.example.com${CALLBACK}`)

  const list = await srv.request('GET', '/api/storage/destinations')
  const dest = list.json.find((d) => d.id === destId)
  assert.equal(dest.secrets.refreshToken, true)
  assert.equal(dest.config.accountEmail, 'owner@example.com')
  assert.doesNotMatch(list.text, /refresh-1/)

  const again = await getManual(`${CALLBACK}?code=good-code&state=${state}`, { auth: false })
  assert.match(again.headers.get('location'), /invalid_state/)
})

test('changing the OAuth client drops the refresh token', () => {
  const dest = destinations.getDestination(destId)
  const next = gdrive.validateConfig({ clientId: 'other.apps.googleusercontent.com' }, dest.config)
  assert.equal(next.refreshToken, '')
  assert.equal(next.clientSecret, 'secret-1')
  const same = gdrive.validateConfig({ clientId: dest.config.clientId }, dest.config)
  assert.equal(same.refreshToken, 'refresh-1')
})

test('resumable upload in chunks with retry, download and delete', async () => {
  const dest = destinations.getDestination(destId)
  const data = crypto.randomBytes(gdrive.CHUNK_SIZE + 12345)
  const file = path.join(env.root, 'big.sql.gz')
  fs.writeFileSync(file, data)
  google.state.failNextChunk = true

  const { fileId } = await gdrive.upload(dest, file, 'big.sql.gz')
  const stored = google.state.files.get(fileId)
  assert.equal(stored.name, 'big.sql.gz')
  assert.deepEqual(stored.parents, ['folder_1'])
  assert.ok(stored.data.equals(data))

  const out = path.join(env.root, 'down.sql.gz')
  await gdrive.download(dest, { fileId }, out)
  assert.ok(fs.readFileSync(out).equals(data))

  await gdrive.remove(dest, { fileId })
  assert.equal(google.state.files.has(fileId), false)
  await gdrive.remove(dest, { fileId }) // already gone → no error
})

test('refreshes an expired access token transparently', async () => {
  google.state.validTokens.clear() // every cached access token is now rejected
  const dest = destinations.getDestination(destId)
  const before = google.state.tokenRequests.length
  const res = await gdrive.test(dest)
  assert.equal(res.ok, true)
  assert.match(res.message, /owner@example.com/)
  assert.ok(google.state.tokenRequests.length > before)
})

test('Test action via the API, and a revoked token reports reconnect', async () => {
  const ok = await srv.request('POST', `/api/storage/destinations/${destId}/test`)
  assert.equal(ok.json.ok, true)

  destinations.patchConfig(destId, { refreshToken: 'revoked' })
  gdrive.setEndpointsForTests(google.endpoints) // clear token cache
  const res = await srv.request('POST', `/api/storage/destinations/${destId}/test`)
  assert.equal(res.json.ok, false)
  assert.match(res.json.message, /revoked or expired/)
})

test('connect is refused for non-Drive destinations', async () => {
  const s3 = await srv.request('POST', '/api/storage/destinations', {
    body: { type: 's3', name: 'b', config: { bucket: 'bkt', accessKeyId: 'a', secretAccessKey: 's' } },
  })
  const res = await srv.request('GET', `/api/storage/gdrive/${s3.json.id}/connect`)
  assert.equal(res.status, 400)
})
