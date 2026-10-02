const BASE = ''

async function req(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }))
    throw new Error(err.error || res.statusText)
  }
  return res.json()
}

/**
 * Upload via XHR (fetch has no upload progress events).
 * @param {FormData} formData
 * @param {(percent: number) => void} [onProgress] - called with 0..100
 */
function upload(formData, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', `${BASE}/api/backups/upload`)

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) {
        onProgress(Math.round((e.loaded / e.total) * 100))
      }
    }

    xhr.onload = () => {
      let body = null
      try { body = JSON.parse(xhr.responseText) } catch { /* non-JSON response */ }
      if (xhr.status >= 200 && xhr.status < 300) return resolve(body)
      reject(new Error(body?.error || xhr.statusText || `Upload failed (${xhr.status})`))
    }
    xhr.onerror = () => reject(new Error('Network error during upload'))
    xhr.onabort = () => reject(new Error('Upload cancelled'))

    xhr.send(formData)
  })
}

export const api = {
  containers: {
    list: () => req('GET', '/api/containers'),
    databases: (name) => req('GET', `/api/containers/${encodeURIComponent(name)}/databases`),
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
    list: () => req('GET', '/api/jobs'),
    get: (jobId) => req('GET', `/api/jobs/${jobId}`),
    streamUrl: (jobId) => `/api/jobs/${jobId}/stream`,
  },
}

