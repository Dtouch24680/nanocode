/** REST API helpers. */

const BASE = '/api'

async function request(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  })
  const data = await res.json()
  if (!res.ok) {
    throw new Error(
      data.error?.fieldErrors
        ? JSON.stringify(data.error)
        : data.error || 'Request failed'
    )
  }
  return data
}

export function fetchProjects() {
  return request('/projects')
}

export function createProject(body) {
  return request('/projects', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export function deleteProject(id) {
  return fetch(`${BASE}/projects/${id}`, { method: 'DELETE' })
}

// --- Tabs (server-side, per-project) ---

export function fetchTabs(projectId) {
  return request(`/projects/${projectId}/tabs`)
}

export function createTab(projectId, label) {
  return request(`/projects/${projectId}/tabs`, {
    method: 'POST',
    body: JSON.stringify(label ? { label } : {}),
  })
}

export function deleteTab(projectId, tabId) {
  return fetch(`${BASE}/projects/${projectId}/tabs/${tabId}`, { method: 'DELETE' })
}

export function patchTab(projectId, tabId, label) {
  return request(`/projects/${projectId}/tabs/${tabId}`, {
    method: 'PATCH',
    body: JSON.stringify({ label }),
  })
}

export function fetchSshHosts() {
  return request('/ssh-hosts')
}

export function testSsh(projectId) {
  return request(`/projects/${projectId}/test-ssh`, { method: 'POST' })
}

export function fetchDir(path) {
  const url = path ? `/fs?path=${encodeURIComponent(path)}` : '/fs'
  return request(url)
}

export function renameFsPath(projectId, from, to) {
  return request(`/projects/${projectId}/files/rename`, {
    method: 'POST',
    body: JSON.stringify({ from, to }),
  })
}
