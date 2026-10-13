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

export async function req(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    credentials: 'same-origin',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }))
    if (res.status === 401 && onUnauthorized) onUnauthorized()
    throw new ApiError(err.error || res.statusText, res.status, err)
  }
  return res.json()
}

const qs = (params) => {
  const s = new URLSearchParams(Object.entries(params).filter(([, v]) => v != null && v !== '')).toString()
  return s ? `?${s}` : ''
}

// ── Chunked upload ────────────────────────────────────────────────────────────
// Large dumps are sent in chunks so no single request exceeds proxy body
// limits (Cloudflare rejects bodies > 100 MB) or long-request timeouts.

const MAX_RETRIES = 5

/** PUT one chunk via XHR (fetch has no upload progress events). */
function putChunk(uploadId, offset, blob, onChunkProgress, signal) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('PUT', `${BASE}/api/uploads/${uploadId}?offset=${offset}`)
    xhr.setRequestHeader('Content-Type', 'application/octet-stream')
    xhr.upload.onprogress = (e) => onChunkProgress(e.loaded)
    xhr.onload = () => {
      let body = null
      try { body = JSON.parse(xhr.responseText) } catch { /* non-JSON response */ }
      if (xhr.status >= 200 && xhr.status < 300) return resolve(body)
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
  servers: {
    list: () => req('GET', '/api/servers'),
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
  jobs: {
    list: (params = {}) => req('GET', `/api/jobs${qs(params)}`),
    get: (jobId) => req('GET', `/api/jobs/${jobId}`),
    streamUrl: (jobId) => `/api/jobs/${jobId}/stream`,
  },
}
