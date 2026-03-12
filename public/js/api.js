/**
 * REST API helpers.
 *
 * Architecture: docs/architecture.md#rest-api
 */

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

export function fetchDiskSessions(projectId, provider = 'claude') {
  return request(
    `/projects/${projectId}/claude-sessions?provider=${encodeURIComponent(provider)}`
  ).catch(() => [])
}

export function fetchRunningSessions(projectId, provider = 'claude') {
  return request(
    `/projects/${projectId}/sessions?provider=${encodeURIComponent(provider)}`
  ).catch(() => [])
}

export function deleteClaudeSession(projectId, sessionId) {
  return fetch(`${BASE}/projects/${projectId}/sessions/${sessionId}`, {
    method: 'DELETE',
  })
}

export function archiveSession(projectId, sessionId) {
  return fetch(`${BASE}/projects/${projectId}/sessions/${sessionId}/archive`, {
    method: 'POST',
  })
}

export function unarchiveSession(projectId, sessionId) {
  return fetch(`${BASE}/projects/${projectId}/sessions/${sessionId}/archive`, {
    method: 'DELETE',
  })
}

export function fetchArchivedSessions(projectId, provider = 'claude') {
  return request(
    `/projects/${projectId}/archived-sessions?provider=${encodeURIComponent(provider)}`
  ).catch(() => [])
}

export function markSessionManaged(projectId, sessionId) {
  return fetch(`${BASE}/projects/${projectId}/sessions/${sessionId}/managed`, {
    method: 'POST',
  })
}

export function fetchManagedDiskSessions(projectId, provider = 'claude') {
  return request(
    `/projects/${projectId}/claude-sessions?managed=1&provider=${encodeURIComponent(provider)}`
  ).catch(() => [])
}

export function testSsh(projectId) {
  return request(`/projects/${projectId}/test-ssh`, { method: 'POST' })
}

export function fetchDir(path) {
  const url = path ? `/fs?path=${encodeURIComponent(path)}` : '/fs'
  return request(url)
}

export function fetchSettings() {
  return request('/settings')
}

export function updateSetting(key, value) {
  return request('/settings', {
    method: 'PUT',
    body: JSON.stringify({ key, value }),
  })
}
