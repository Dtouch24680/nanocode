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

export function fetchTasks() {
  return request('/tasks')
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
