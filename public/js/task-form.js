/**
 * Task creation form handler.
 *
 * Architecture: docs/architecture.md#rest-task-crud
 */

import { createTask } from './api.js'

/**
 * Initialize the task creation form.
 */
export function initForm() {
  const form = document.getElementById('task-form')

  form.addEventListener('submit', async (e) => {
    e.preventDefault()

    const title = document.getElementById('task-title').value.trim()
    const cwd = document.getElementById('task-cwd').value.trim()
    const type = document.getElementById('task-type').value
    const dependsOn =
      document.getElementById('task-depends').value.trim() || undefined

    if (!title || !cwd) return

    try {
      await createTask({ title, cwd, type, dependsOn })
      // Clear form on success
      document.getElementById('task-title').value = ''
      document.getElementById('task-depends').value = ''
    } catch (err) {
      console.error('Failed to create task:', err.message)
    }
  })
}
