/**
 * Task creation form handler.
 * Uses the active project's cwd automatically.
 *
 * Architecture: docs/architecture.md#rest-task-crud
 */

import { state } from './state.js'
import { createTask } from './api.js'

/**
 * Initialize the task creation form.
 */
export function initForm() {
  const form = document.getElementById('task-form')

  form.addEventListener('submit', async (e) => {
    e.preventDefault()

    const title = document.getElementById('task-title').value.trim()
    const type = document.getElementById('task-type').value
    const dependsOn =
      document.getElementById('task-depends').value.trim() || undefined

    if (!title) return

    const body = { title, type, dependsOn }

    // Use active project's ID (cwd resolved server-side)
    if (state.activeProjectId) {
      body.projectId = state.activeProjectId
    }

    try {
      await createTask(body)
      document.getElementById('task-title').value = ''
      document.getElementById('task-depends').value = ''
    } catch (err) {
      console.error('Failed to create task:', err.message)
    }
  })
}
