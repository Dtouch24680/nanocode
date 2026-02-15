/**
 * Renders the kanban board with 4 columns, filtered by active project.
 *
 * Architecture: public/docs/state-management.md#board-rendering
 */

import { state } from './state.js'
import { renderCard } from './task-card.js'

const STATUS_COLUMNS = {
  pending: 'col-pending',
  running: 'col-running',
  review: 'col-review',
  done: 'col-done',
}

/**
 * Render tasks into their respective kanban columns.
 * Filters to active project (shows legacy tasks without project_id in all projects).
 *
 * Architecture: public/docs/state-management.md#board-rendering
 */
export function renderBoard() {
  for (const colId of Object.values(STATUS_COLUMNS)) {
    document.getElementById(colId).innerHTML = ''
  }

  const projectId = state.activeProjectId

  for (const task of state.tasks) {
    // Filter by project: show tasks matching active project or legacy tasks without project_id
    if (projectId && task.project_id && task.project_id !== projectId) continue

    const col =
      task.status === 'failed' || task.status === 'cancelled'
        ? 'done'
        : task.status
    const colId = STATUS_COLUMNS[col]
    if (colId) {
      document.getElementById(colId).appendChild(renderCard(task))
    }
  }
}
