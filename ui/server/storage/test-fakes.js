const http = require('http')

// In-process fakes of the S3 and Google APIs used by the storage tests. Nothing in
// the test suite talks to real AWS or Google endpoints.

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)))
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

/**
 * Minimal path-style S3: PUT/GET/DELETE /<bucket>/<key>.
 * `objects` maps "bucket/key" → Buffer. Set `failPuts` to make uploads fail.
 */
async function startFakeS3() {
  const state = { objects: new Map(), requests: [], failPuts: false }
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x')
    const key = decodeURIComponent(url.pathname.slice(1))
    const body = await readBody(req)
    state.requests.push({ method: req.method, key, headers: req.headers })
    if (req.method === 'PUT') {
      if (state.failPuts) {
        res.writeHead(403, { 'content-type': 'application/xml' })
        return res.end('<Error><Code>AccessDenied</Code><Message>denied</Message></Error>')
      }
      state.objects.set(key, body)
      res.writeHead(200, { etag: '"abc"' })
      return res.end()
    }
    if (req.method === 'GET') {
      const obj = state.objects.get(key)
      if (!obj) {
        res.writeHead(404, { 'content-type': 'application/xml' })
        return res.end('<Error><Code>NoSuchKey</Code><Message>missing</Message></Error>')
      }
      res.writeHead(200, { 'content-length': obj.length, 'content-type': 'application/octet-stream' })
      return res.end(obj)
    }
    if (req.method === 'DELETE') {
      state.objects.delete(key)
      res.writeHead(204)
      return res.end()
    }
    res.writeHead(405)
    res.end()
  })
  const url = await listen(server)
  return { url, state, close: () => new Promise((r) => server.close(r)) }
}

/**
 * Fake Google OAuth token endpoint + Drive v3 (resumable upload, media
 * download, delete, about). Tokens: refresh token 'refresh-1' is valid.
 */
async function startFakeGoogle() {
  const state = {
    files: new Map(),
    sessions: new Map(),
    tokenRequests: [],
    validTokens: new Set(),
    failNextChunk: false,
    seq: 0,
  }
  const json = (res, status, body, headers = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers })
    res.end(JSON.stringify(body))
  }
  const authorised = (req) => state.validTokens.has((req.headers.authorization || '').replace('Bearer ', ''))

  async function token(req, res) {
    const params = new URLSearchParams((await readBody(req)).toString())
    state.tokenRequests.push(Object.fromEntries(params))
    if (params.get('client_secret') !== 'secret-1') return json(res, 401, { error: 'invalid_client' })
    if (params.get('grant_type') === 'authorization_code' && params.get('code') !== 'good-code') {
      return json(res, 400, { error: 'invalid_grant' })
    }
    if (params.get('grant_type') === 'refresh_token' && params.get('refresh_token') !== 'refresh-1') {
      return json(res, 400, { error: 'invalid_grant' })
    }
    const access = `access-${++state.seq}`
    state.validTokens.add(access)
    return json(res, 200, { access_token: access, expires_in: 3600, refresh_token: 'refresh-1' })
  }

  async function chunk(req, res, id) {
    const session = state.sessions.get(id)
    const body = await readBody(req)
    if (!session) return json(res, 404, { error: { message: 'no session' } })
    if (state.failNextChunk && body.length > 0) {
      state.failNextChunk = false
      return json(res, 503, { error: { message: 'try later' } })
    }
    const m = /bytes (\d+)-(\d+)\/(\d+)/.exec(req.headers['content-range'] || '')
    if (m) session.data = Buffer.concat([session.data.subarray(0, Number(m[1])), body])
    if (session.data.length >= session.size) {
      const fileId = `file${++state.seq}abcdef`
      state.files.set(fileId, { name: session.name, parents: session.parents, data: session.data })
      state.sessions.delete(id)
      return json(res, 200, { id: fileId })
    }
    const headers = session.data.length ? { range: `bytes=0-${session.data.length - 1}` } : {}
    res.writeHead(308, headers)
    res.end()
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x')
    if (url.pathname === '/token') return token(req, res)
    if (url.pathname.startsWith('/session/')) return chunk(req, res, url.pathname.split('/')[2])
    if (!authorised(req)) return json(res, 401, { error: { message: 'bad token' } })
    if (url.pathname === '/upload/files' && req.method === 'POST') {
      const meta = JSON.parse((await readBody(req)).toString())
      const id = `s${++state.seq}`
      state.sessions.set(id, { name: meta.name, parents: meta.parents, size: Number(req.headers['x-upload-content-length']), data: Buffer.alloc(0) })
      res.writeHead(200, { location: `${base}/session/${id}` })
      return res.end()
    }
    if (url.pathname === '/api/about') return json(res, 200, { user: { emailAddress: 'owner@example.com' } })
    const fileMatch = /^\/api\/files\/([^/]+)$/.exec(url.pathname)
    if (fileMatch) {
      const file = state.files.get(fileMatch[1])
      if (!file) return json(res, 404, { error: { message: 'not found' } })
      if (req.method === 'DELETE') { state.files.delete(fileMatch[1]); res.writeHead(204); return res.end() }
      res.writeHead(200, { 'content-type': 'application/octet-stream' })
      return res.end(file.data)
    }
    json(res, 404, { error: { message: 'unknown' } })
  })
  const base = await listen(server)
  return {
    url: base,
    state,
    endpoints: { auth: `${base}/auth`, token: `${base}/token`, api: `${base}/api`, upload: `${base}/upload` },
    close: () => new Promise((r) => server.close(r)),
  }
}

module.exports = { startFakeS3, startFakeGoogle }
