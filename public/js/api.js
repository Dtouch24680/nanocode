/**
 * REST API helpers (fetch wrappers).
 *
 * Architecture: docs/architecture.md#rest-task-crud
 */

const BASE = '/api'

async function request(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error?.fieldErrors ? JSON.stringify(data.error) : data.error || 'Request failed')
  return data
}

// --- Projects ---

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

// --- Tasks ---

export function fetchTasks(projectId) {
  const params = projectId ? `?projectId=${projectId}` : ''
  return request(`/tasks${params}`)
}

export function createTask(body) {
  return request('/tasks', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export function updateTask(id, body) {
  return request(`/tasks/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  })
}

export function confirmPlan(id, body = {}) {
  return request(`/tasks/${id}/confirm`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export function revisePlan(id, body) {
  return request(`/tasks/${id}/revise`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export function continueTask(id, body) {
  return request(`/tasks/${id}/continue`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export function fetchEvents(taskId, afterId = 0) {
  const params = afterId ? `?after=${afterId}` : ''
  return request(`/tasks/${taskId}/events${params}`)
}

// --- Terminal helpers ---

export function fetchDiskSessions(projectId) {
  return request(`/projects/${projectId}/claude-sessions`).catch(() => [])
}

export function fetchRunningSessions(projectId) {
  return request(`/projects/${projectId}/sessions`).catch(() => [])
}

export function deleteClaudeSession(projectId, sessionId) {
  return fetch(`${BASE}/projects/${projectId}/sessions/${sessionId}`, { method: 'DELETE' })
}

export function archiveSession(projectId, sessionId) {
  return fetch(`${BASE}/projects/${projectId}/sessions/${sessionId}/archive`, { method: 'POST' })
}

export function unarchiveSession(projectId, sessionId) {
  return fetch(`${BASE}/projects/${projectId}/sessions/${sessionId}/archive`, { method: 'DELETE' })
}

export function fetchArchivedSessions(projectId) {
  return request(`/projects/${projectId}/archived-sessions`).catch(() => [])
}

export function markSessionManaged(projectId, sessionId) {
  return fetch(`${BASE}/projects/${projectId}/sessions/${sessionId}/managed`, { method: 'POST' })
}

export function fetchManagedDiskSessions(projectId) {
  return request(`/projects/${projectId}/claude-sessions?managed=1`).catch(() => [])
}

export function fetchDir(path) {
  const url = path ? `/fs?path=${encodeURIComponent(path)}` : '/fs'
  return request(url)
}

// --- Settings ---

export function fetchSettings() {
  return request('/settings')
}

export function updateSetting(key, value) {
  return request('/settings', {
    method: 'PUT',
    body: JSON.stringify({ key, value }),
  })
}
