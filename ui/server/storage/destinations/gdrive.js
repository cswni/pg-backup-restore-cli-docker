const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const { Readable } = require('stream')
const { pipeline } = require('stream/promises')
const { httpError } = require('../../validation')

// Google Drive destination using the admin's own Google account (OAuth 2.0
// "Web application" client, scope drive.file). Plain fetch, no googleapis
// dependency. Uploads use the Drive v3 resumable protocol, streamed from
// disk in CHUNK_SIZE pieces.

const SCOPE = 'https://www.googleapis.com/auth/drive.file'
const CHUNK_SIZE = 8 * 1024 * 1024 // must be a multiple of 256 KiB
const MAX_CHUNK_RETRIES = 5
const ID_RE = /^[A-Za-z0-9_-]{1,200}$/

const DEFAULT_ENDPOINTS = Object.freeze({
  auth: 'https://accounts.google.com/o/oauth2/v2/auth',
  token: 'https://oauth2.googleapis.com/token',
  api: 'https://www.googleapis.com/drive/v3',
  upload: 'https://www.googleapis.com/upload/drive/v3',
})
let endpoints = { ...DEFAULT_ENDPOINTS }
let retryDelayMs = 1000

/** Test helper: point at a fake Google server. */
function setEndpointsForTests(overrides, { retryDelay = 0 } = {}) {
  endpoints = { ...DEFAULT_ENDPOINTS, ...overrides }
  retryDelayMs = retryDelay
  tokenCache.clear()
}

function str(value, field, max) {
  if (value === undefined || value === null || value === '') return ''
  if (typeof value !== 'string' || value.length > max) throw httpError(400, `${field} must be a string (max ${max} chars)`)
  return value.trim()
}

/**
 * Validate Drive settings. Empty clientSecret keeps the stored one; changing
 * the client id drops the refresh token (it belongs to the old client).
 */
function validateConfig(input = {}, current = {}) {
  const clientId = str(input.clientId, 'clientId', 256)
  if (!clientId || !/^[A-Za-z0-9._-]+$/.test(clientId)) throw httpError(400, 'clientId is required (OAuth client ID)')
  const clientSecret = str(input.clientSecret, 'clientSecret', 256) || current.clientSecret
  if (!clientSecret) throw httpError(400, 'clientSecret is required')
  const folderId = str(input.folderId, 'folderId', 200)
  if (folderId && !ID_RE.test(folderId)) throw httpError(400, 'folderId is invalid')
  const sameClient = current.clientId === clientId
  return {
    clientId,
    clientSecret,
    folderId,
    refreshToken: sameClient ? current.refreshToken || '' : '',
    accountEmail: sameClient ? current.accountEmail || '' : '',
  }
}

/** Google consent URL for the connect flow. */
function authUrl({ clientId, redirectUri, state }) {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPE,
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
  })
  return `${endpoints.auth}?${params}`
}

async function tokenRequest(params) {
  const res = await fetch(endpoints.token, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) {
    const err = new Error(`Google token endpoint: ${body.error_description || body.error || res.status}`)
    err.code = body.error
    throw err
  }
  return body
}

/** Exchange an authorization code; returns { refreshToken, accessToken, expiresIn }. */
async function exchangeCode({ clientId, clientSecret, code, redirectUri }) {
  const body = await tokenRequest({
    client_id: clientId, client_secret: clientSecret, code, redirect_uri: redirectUri, grant_type: 'authorization_code',
  })
  if (!body.refresh_token) throw new Error('Google did not return a refresh token; remove the app from your Google account permissions and connect again')
  return { refreshToken: body.refresh_token, accessToken: body.access_token, expiresIn: body.expires_in }
}

// destinationId → { token, expiresAt, refreshToken }
const tokenCache = new Map()

async function accessToken(dest) {
  const { refreshToken, clientId, clientSecret } = dest.config
  if (!refreshToken) throw new Error(`Google Drive destination '${dest.name}' is not connected. Use "Connect Google Drive"`)
  const cached = tokenCache.get(dest.id)
  if (cached && cached.refreshToken === refreshToken && cached.expiresAt > Date.now() + 60_000) return cached.token
  try {
    const body = await tokenRequest({
      client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: 'refresh_token',
    })
    tokenCache.set(dest.id, { token: body.access_token, expiresAt: Date.now() + (body.expires_in || 3600) * 1000, refreshToken })
    return body.access_token
  } catch (err) {
    if (err.code === 'invalid_grant') throw new Error(`Google Drive access for '${dest.name}' was revoked or expired. Connect it again`)
    throw err
  }
}

/** fetch() with a bearer token; refreshes the token once on 401. */
async function driveFetch(dest, url, init = {}) {
  const send = async () => fetch(url, { ...init, headers: { ...init.headers, authorization: `Bearer ${await accessToken(dest)}` } })
  let res = await send()
  if (res.status === 401) {
    tokenCache.delete(dest.id)
    res = await send()
  }
  return res
}

async function assertOk(res, what) {
  if (res.ok) return res
  const text = await res.text().catch(() => '')
  let detail = text
  try { detail = JSON.parse(text).error?.message || text } catch { /* not JSON */ }
  throw new Error(`Google Drive ${what} failed (${res.status}): ${String(detail).slice(0, 300)}`)
}

/** E-mail of the connected account (best effort, for display). */
async function accountEmail(dest) {
  const res = await driveFetch(dest, `${endpoints.api}/about?fields=user(emailAddress)`)
  if (!res.ok) return ''
  return (await res.json()).user?.emailAddress || ''
}

async function startSession(dest, name, size) {
  const meta = { name, ...(dest.config.folderId ? { parents: [dest.config.folderId] } : {}) }
  const res = await driveFetch(dest, `${endpoints.upload}/files?uploadType=resumable&supportsAllDrives=true&fields=id`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json; charset=UTF-8',
      'x-upload-content-type': 'application/octet-stream',
      'x-upload-content-length': String(size),
    },
    body: JSON.stringify(meta),
  })
  await assertOk(res, 'upload session')
  const session = res.headers.get('location')
  if (!session) throw new Error('Google Drive did not return an upload session URL')
  return session
}

function readChunk(fd, offset, length) {
  const buf = Buffer.alloc(length)
  const n = fs.readSync(fd, buf, 0, length, offset)
  return buf.subarray(0, n)
}

/** Next offset from a 308 response's Range header ("bytes=0-N"). */
function nextOffset(res) {
  const m = /bytes=0-(\d+)/.exec(res.headers.get('range') || '')
  return m ? Number(m[1]) + 1 : 0
}

/** PUT one chunk (or a status query when `chunk` is null). */
async function putChunk(dest, session, chunk, offset, size) {
  const range = chunk ? `bytes ${offset}-${offset + chunk.length - 1}/${size}` : `bytes */${size}`
  return driveFetch(dest, session, {
    method: 'PUT',
    headers: { 'content-length': String(chunk ? chunk.length : 0), 'content-range': range },
    body: chunk || undefined,
  })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Interpret a chunk/status response: { done, id } or { offset }. Throws on fatal errors. */
async function chunkResult(res) {
  if (res.status === 200 || res.status === 201) return { done: true, id: (await res.json()).id }
  if (res.status === 308) return { offset: nextOffset(res) }
  if (res.status === 404 || res.status === 410) throw new Error('Google Drive upload session expired')
  if (res.status >= 500 || res.status === 429) return { retry: true }
  await assertOk(res, 'chunk upload')
  return { retry: true }
}

const FATAL_RE = /expired|failed \(4|connect/

/** Send a chunk/status request; network and 5xx errors become { retry: true }. */
async function attempt(dest, session, chunk, offset, size) {
  try {
    return await chunkResult(await putChunk(dest, session, chunk, offset, size))
  } catch (err) {
    if (FATAL_RE.test(err.message)) throw err
    return { retry: true }
  }
}

/** Upload `file` as `name`; returns { fileId }. */
async function upload(dest, file, name) {
  const size = fs.statSync(file).size
  const session = await startSession(dest, name, size)
  const fd = fs.openSync(file, 'r')
  try {
    let offset = 0
    let retries = 0
    let result = { offset: 0 }
    while (!result.done) {
      if (result.retry) {
        if (++retries > MAX_CHUNK_RETRIES) throw new Error('Google Drive upload failed after retries')
        await sleep(retryDelayMs * 2 ** (retries - 1))
        result = await attempt(dest, session, null, offset, size) // where did the server stop?
        continue
      }
      offset = result.offset
      const chunk = size === 0 ? null : readChunk(fd, offset, Math.min(CHUNK_SIZE, size - offset))
      result = await attempt(dest, session, chunk, offset, size)
      if (result.offset !== undefined && result.offset <= offset) result = { retry: true } // no progress
      if (!result.retry) retries = 0
    }
    return { fileId: result.id }
  } finally {
    fs.closeSync(fd)
  }
}

function fileUrl(location, query = '') {
  if (!ID_RE.test(String(location.fileId || ''))) throw new Error('Invalid Google Drive file id')
  return `${endpoints.api}/files/${encodeURIComponent(location.fileId)}?supportsAllDrives=true${query}`
}

async function download(dest, location, outFile) {
  const res = await assertOk(await driveFetch(dest, fileUrl(location, '&alt=media')), 'download')
  try {
    await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(outFile))
  } catch (err) {
    fs.rmSync(outFile, { force: true })
    throw err
  }
}

/** Delete a Drive file; an already-missing file is not an error. */
async function remove(dest, location) {
  const res = await driveFetch(dest, fileUrl(location), { method: 'DELETE' })
  if (res.status === 404) return
  await assertOk(res, 'delete')
}

/** Upload and delete a small probe file. */
async function test(dest) {
  const probe = path.join(os.tmpdir(), `pgbackup-probe-${crypto.randomUUID()}`)
  fs.writeFileSync(probe, 'pg-backup probe')
  try {
    const { fileId } = await upload(dest, probe, path.basename(probe))
    await remove(dest, { fileId })
    const email = await accountEmail(dest)
    return { ok: true, message: `Uploaded and deleted a probe file${email ? ` as ${email}` : ''}` }
  } finally {
    fs.rmSync(probe, { force: true })
  }
}

module.exports = {
  type: 'gdrive', SCOPE, CHUNK_SIZE, validateConfig, authUrl, exchangeCode, accountEmail,
  upload, download, remove, test, setEndpointsForTests,
}
