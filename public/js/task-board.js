/**
 * Renders the kanban board with 4 columns.
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
 * Render all tasks into their respective kanban columns.
 *
 * Architecture: public/docs/state-management.md#board-rendering
 */
export function renderBoard() {
  // Clear all columns
  for (const colId of Object.values(STATUS_COLUMNS)) {
    document.getElementById(colId).innerHTML = ''
  }

  for (const task of state.tasks) {
    // Map failed/cancelled to the done column
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
