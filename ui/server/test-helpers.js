// Shared helpers for `node --test` integration tests.
// Each *.test.js file runs in its own process, so call setupTestEnv() at the
// top of the file BEFORE requiring any server module (config reads env once).
const fs = require('fs')
const os = require('os')
const path = require('path')

const TEST_USER = 'test-admin'
const TEST_PASSWORD = 'test-password'

function setupTestEnv(extraEnv = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pgui-test-'))
  const env = {
    BACKUPS_DIR: path.join(root, 'backups'),
    DATA_DIR: path.join(root, 'data'),
    APP_SECRET: 'test-secret',
    BASIC_AUTH_USER: TEST_USER,
    BASIC_AUTH_PASSWORD: TEST_PASSWORD,
    ...extraEnv,
  }
  Object.assign(process.env, env)
  fs.mkdirSync(env.BACKUPS_DIR, { recursive: true })
  return { root, ...env }
}

/** Start the app on an ephemeral port. Returns { url, close, request }. */
async function startTestServer() {
  const { createApp } = require('./app')
  const app = createApp()
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s))
  })
  const url = `http://127.0.0.1:${server.address().port}`
  const auth = 'Basic ' + Buffer.from(`${TEST_USER}:${TEST_PASSWORD}`).toString('base64')

  /** fetch() with auth; `body` objects are sent as JSON. */
  async function request(method, p, { body, headers = {}, raw, noAuth } = {}) {
    const init = { method, headers: { ...(noAuth ? {} : { authorization: auth }), ...headers } }
    if (raw !== undefined) {
      init.body = raw
    } else if (body !== undefined) {
      init.body = JSON.stringify(body)
      init.headers['content-type'] = 'application/json'
    }
    const res = await fetch(url + p, init)
    const text = await res.text()
    let json = null
    try { json = JSON.parse(text) } catch { /* not JSON */ }
    return { status: res.status, json, text, headers: res.headers }
  }

  return { url, request, close: () => new Promise((r) => server.close(r)) }
}

module.exports = { setupTestEnv, startTestServer, TEST_USER, TEST_PASSWORD }
