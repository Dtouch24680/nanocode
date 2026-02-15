/**
 * Task creation form handler.
 * Uses the active project's cwd automatically.
 *
 * - `plan:` prefix auto-sets type to plan (strips prefix)
 * - Shift+Enter toggles advanced options visibility
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
  const titleInput = document.getElementById('task-title')
  const typeSelect = document.getElementById('task-type')
  const dependsInput = document.getElementById('task-depends')
  const advancedRow = document.getElementById('form-advanced')

  // Shift+Enter toggles advanced options
  titleInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.shiftKey) {
      e.preventDefault()
      advancedRow.hidden = !advancedRow.hidden
    }
  })

  form.addEventListener('submit', async (e) => {
    e.preventDefault()

    let title = titleInput.value.trim()
    if (!title) return

    // Auto-detect plan: prefix when advanced is hidden
    let type = typeSelect.value
    if (advancedRow.hidden && title.toLowerCase().startsWith('plan:')) {
      type = 'plan'
      title = title.slice(5).trim()
      if (!title) return
    }

    const dependsOn = dependsInput.value.trim() || undefined

    const body = { title, type, dependsOn }

    // Use active project's ID (cwd resolved server-side)
    if (state.activeProjectId) {
      body.projectId = state.activeProjectId
    }

    try {
      await createTask(body)
      titleInput.value = ''
      dependsInput.value = ''
      typeSelect.value = 'task'
      advancedRow.hidden = true
    } catch (err) {
      console.error('Failed to create task:', err.message)
    }
  })
}
