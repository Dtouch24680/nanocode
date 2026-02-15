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

export function fetchDir(path) {
  const url = path ? `/fs?path=${encodeURIComponent(path)}` : '/fs'
  return request(url)
}
