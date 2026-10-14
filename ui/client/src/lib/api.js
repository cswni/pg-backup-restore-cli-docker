const BASE = ''

/** Error with the HTTP status attached (e.g. 401 → login, 403 → forbidden). */
export class ApiError extends Error {
  constructor(message, status, body) {
    super(message)
    this.status = status
    this.body = body
  }
}

// Called on any 401 so the auth layer can redirect to the login page.
let onUnauthorized = null
export function setUnauthorizedHandler(fn) {
  onUnauthorized = fn
}

// Sent on every request; the server requires it for cookie-authenticated
// POST/PUT/PATCH/DELETE (CSRF protection: cross-site forms cannot set it).
const CSRF_HEADERS = { 'X-Requested-With': 'pgui' }

export async function req(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    credentials: 'same-origin',
    headers: body ? { ...CSRF_HEADERS, 'Content-Type': 'application/json' } : CSRF_HEADERS,
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }))
    if (res.status === 401 && onUnauthorized) onUnauthorized()
    throw new ApiError(err.error || res.statusText, res.status, err)
  }
  return res.json()
}

export const qs = (params) => {
  const s = new URLSearchParams(Object.entries(params).filter(([, v]) => v != null && v !== '')).toString()
  return s ? `?${s}` : ''
}

// Large backups are uploaded in chunks so no single request exceeds proxy body
// limits (Cloudflare rejects bodies > 100 MB) or long-request timeouts.

const MAX_RETRIES = 5

/** PUT one chunk via XHR (fetch has no upload progress events). */
function putChunk(uploadId, offset, blob, onChunkProgress, signal) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('PUT', `${BASE}/api/uploads/${uploadId}?offset=${offset}`)
    xhr.setRequestHeader('Content-Type', 'application/octet-stream')
    for (const [name, value] of Object.entries(CSRF_HEADERS)) xhr.setRequestHeader(name, value)
    xhr.upload.onprogress = (e) => onChunkProgress(e.loaded)
    xhr.onload = () => {
      let body = null
      try { body = JSON.parse(xhr.responseText) } catch { /* non-JSON response */ }
      if (xhr.status >= 200 && xhr.status < 300) return resolve(body)
      if (xhr.status === 401 && onUnauthorized) onUnauthorized()
      reject(new ApiError(body?.error || xhr.statusText || `Upload failed (${xhr.status})`, xhr.status, body))
    }
    xhr.onerror = () => reject(new ApiError('Network error during upload', 0))
    xhr.onabort = () => reject(new ApiError('Upload cancelled', -1))
    signal?.addEventListener('abort', () => xhr.abort(), { once: true })
    xhr.send(blob)
  })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * Upload a File in resumable chunks, then optionally start a restore.
 * @param {File} file
 * @param {object} [restore]  { serverId, engine, container, database, dropExisting } to restore after upload
 * @param {(percent: number) => void} [onProgress]  0..100
 * @param {AbortSignal} [signal]
 * @returns {Promise<{ filename: string, jobId?: string }>}
 */
async function upload(file, { restore, onProgress, signal } = {}) {
  const { uploadId, chunkSize } = await req('POST', '/api/uploads', { filename: file.name, size: file.size })
  const report = (bytes) => onProgress?.(Math.min(100, Math.floor((bytes / file.size) * 100)))

  try {
    let offset = 0
    let retries = 0
    while (offset < file.size) {
      if (signal?.aborted) throw new ApiError('Upload cancelled', -1)
      const end = Math.min(offset + chunkSize, file.size)
      try {
        const { received } = await putChunk(uploadId, offset, file.slice(offset, end),
          (loaded) => report(offset + loaded), signal)
        offset = received
        retries = 0
      } catch (err) {
        if (err.status === -1 || err.status === 401 || retries >= MAX_RETRIES) throw err
        retries += 1
        await sleep(1000 * 2 ** (retries - 1))
        // Re-sync with what the server actually stored (handles partial chunks)
        offset = (await req('GET', `/api/uploads/${uploadId}`)).received
      }
      report(offset)
    }
    return await req('POST', `/api/uploads/${uploadId}/complete`, restore ? { restore: true, ...restore } : {})
  } catch (err) {
    req('DELETE', `/api/uploads/${uploadId}`).catch(() => {})
    throw err
  }
}

export const api = {
  auth: {
    me: () => req('GET', '/api/auth/me'),
    login: (username, password) => req('POST', '/api/auth/login', { username, password }),
    logout: () => req('POST', '/api/auth/logout'),
    updateProfile: (profile) => req('PUT', '/api/auth/me', profile),
    changePassword: (currentPassword, newPassword) =>
      req('PUT', '/api/auth/me/password', { currentPassword, newPassword }),
  },
  users: {
    list: () => req('GET', '/api/users'),
    create: (user) => req('POST', '/api/users', user),
    update: (id, changes) => req('PUT', `/api/users/${id}`, changes),
    delete: (id) => req('DELETE', `/api/users/${id}`),
  },
  servers: {
    list: () => req('GET', '/api/servers'),
    get: (id) => req('GET', `/api/servers/${encodeURIComponent(id)}`),
    create: (server) => req('POST', '/api/servers', server),
    // Empty secret fields (privateKey, password) keep the stored values
    update: (id, server) => req('PUT', `/api/servers/${encodeURIComponent(id)}`, server),
    remove: (id) => req('DELETE', `/api/servers/${encodeURIComponent(id)}`),
    test: (id) => req('POST', `/api/servers/${encodeURIComponent(id)}/test`),
    forgetHostKey: (id) => req('DELETE', `/api/servers/${encodeURIComponent(id)}/host-key`),
    databases: (id) => req('GET', `/api/servers/${encodeURIComponent(id)}/databases`),
  },
  engines: {
    list: () => req('GET', '/api/engines'),
  },
  containers: {
    list: (serverId) => req('GET', `/api/containers${qs({ serverId })}`),
    databases: (name, { serverId, engine } = {}) =>
      req('GET', `/api/containers/${encodeURIComponent(name)}/databases${qs({ serverId, engine })}`),
  },
  backups: {
    list: () => req('GET', '/api/backups'),
    delete: (filename) => req('DELETE', `/api/backups/${encodeURIComponent(filename)}`),
    downloadUrl: (filename) => `/api/backups/${encodeURIComponent(filename)}/download`,
    upload,
  },
  ops: {
    run: (operation, payload) => req('POST', `/api/ops/${operation}`, payload),
  },
  storage: {
    defaults: () => req('GET', '/api/storage/defaults'),
    settings: () => req('GET', '/api/storage/settings'),
    saveSettings: (body) => req('PUT', '/api/storage/settings', body),
    destinations: () => req('GET', '/api/storage/destinations'),
    createDestination: (body) => req('POST', '/api/storage/destinations', body),
    updateDestination: (id, body) => req('PUT', `/api/storage/destinations/${encodeURIComponent(id)}`, body),
    deleteDestination: (id) => req('DELETE', `/api/storage/destinations/${encodeURIComponent(id)}`),
    testDestination: (id) => req('POST', `/api/storage/destinations/${encodeURIComponent(id)}/test`),
    // Full-page navigation: the server redirects to Google's consent screen
    gdriveConnectUrl: (id) => `/api/storage/gdrive/${encodeURIComponent(id)}/connect`,
    runRetention: () => req('POST', '/api/storage/retention/run'),
    deleteRemoteCopies: (filename) => req('DELETE', `/api/storage/backups/${encodeURIComponent(filename)}/remote`),
  },
  jobs: {
    list: (params = {}) => req('GET', `/api/jobs${qs(params)}`),
    get: (jobId) => req('GET', `/api/jobs/${jobId}`),
    streamUrl: (jobId) => `/api/jobs/${jobId}/stream`,
  },
  schedules: {
    list: () => req('GET', '/api/schedules'),
    get: (id) => req('GET', `/api/schedules/${encodeURIComponent(id)}`),
    create: (schedule) => req('POST', '/api/schedules', schedule),
    update: (id, patch) => req('PUT', `/api/schedules/${encodeURIComponent(id)}`, patch),
    remove: (id) => req('DELETE', `/api/schedules/${encodeURIComponent(id)}`),
    run: (id) => req('POST', `/api/schedules/${encodeURIComponent(id)}/run`),
    preview: (cron, tz) => req('GET', `/api/schedules/preview${qs({ cron, tz })}`),
  },
  explorer: {
    // params: { serverId, engine, container, database, schema, name, limit, offset, sort, dir, filter }
    objects: (params) => req('GET', `/api/explorer/objects${qs(params)}`),
    structure: (params) => req('GET', `/api/explorer/structure${qs(params)}`),
    rows: (params) => req('GET', `/api/explorer/rows${qs(params)}`),
    // body: { serverId, engine, container, database, sql, limit }; admin only
    query: (body) => req('POST', '/api/explorer/query', body),
  },
  monitoring: {
    health: () => req('GET', '/api/health'),
    summary: () => req('GET', '/api/monitoring/summary'),
    settings: () => req('GET', '/api/monitoring/settings'),
    createWebhook: (webhook) => req('POST', '/api/monitoring/settings/webhooks', webhook),
    updateWebhook: (id, patch) => req('PUT', `/api/monitoring/settings/webhooks/${encodeURIComponent(id)}`, patch),
    deleteWebhook: (id) => req('DELETE', `/api/monitoring/settings/webhooks/${encodeURIComponent(id)}`),
    testWebhook: (id) => req('POST', `/api/monitoring/settings/webhooks/${encodeURIComponent(id)}/test`),
  },
}
