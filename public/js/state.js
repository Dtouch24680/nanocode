/**
 * Mutable application state + render dispatch.
 *
 * WebSocket messages mutate state directly and call the affected
 * render function. No immutability discipline — no virtual DOM.
 *
 * Architecture: public/docs/state-management.md
 */

import { renderBoard } from './task-board.js'
import { renderDetail, appendEventToStream } from './task-detail.js'
import { showPlanReview } from './plan-review.js'
import { renderSidebar } from './sidebar.js'

export const state = {
  projects: [],
  activeProjectId: null,
  activeTab: 'tasks', // 'tasks' | 'terminal'
  tasks: [],
  events: new Map(),
  selectedTaskId: null,
  cliProvider: 'claude', // 'claude' | 'agent'
}

/**
 * Update or insert a task, then re-render affected views.
 *
 * @param {object} task
 */
export function taskUpdated(task) {
  const idx = state.tasks.findIndex((t) => t.id === task.id)
  if (idx >= 0) state.tasks[idx] = task
  else state.tasks.push(task)

  renderBoard()
  renderSidebar()

  if (task.id === state.selectedTaskId) {
    if (task.status === 'review') {
      showPlanReview(task)
    } else {
      renderDetail()
    }
  }
}

/**
 * Append a new event for a task.
 *
 * @param {string} taskId
 * @param {object} event
 */
export function eventReceived(taskId, event) {
  if (!state.events.has(taskId)) state.events.set(taskId, [])
  state.events.get(taskId).push(event)
  if (taskId === state.selectedTaskId) appendEventToStream(event)
}

/**
 * Select a task for detail view.
 *
 * @param {string|null} taskId
 */
export function selectTask(taskId) {
  state.selectedTaskId = taskId
  if (taskId) {
    const task = state.tasks.find((t) => t.id === taskId)
    if (task && task.status === 'review') {
      showPlanReview(task)
    } else {
      renderDetail()
    }
  } else {
    document.getElementById('detail-panel').hidden = true
    document.getElementById('plan-review-panel').hidden = true
  }
  renderBoard()
}
