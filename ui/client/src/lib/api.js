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

async function upload(formData) {
  const res = await fetch(`${BASE}/api/backups/upload`, {
    method: 'POST',
    body: formData,
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }))
    throw new Error(err.error || res.statusText)
  }
  return res.json()
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

