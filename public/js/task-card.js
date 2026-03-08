/**
 * Renders a single task summary card for the kanban board.
 *
 * Architecture: public/docs/event-rendering.md#task-card
 */

import { el, formatCost, timeAgo } from './render.js'
import { state, selectTask } from './state.js'

/**
 * Create a task card DOM element.
 *
 * @param {object} task
 * @returns {HTMLElement}
 */
export function renderCard(task) {
  const isSelected = task.id === state.selectedTaskId

  const typeBadge = el('span', {
    className: `badge badge-${task.type}`,
    textContent: task.type,
  })

  const meta = [typeBadge]

  if (task.status === 'failed') {
    meta.push(el('span', { className: 'badge badge-failed', textContent: 'failed' }))
  }
  if (task.status === 'cancelled') {
    meta.push(
      el('span', {
        className: 'badge badge-cancelled',
        textContent: 'cancelled',
      })
    )
  }

  if (task.cost_usd > 0) {
    meta.push(el('span', { textContent: formatCost(task.cost_usd) }))
  }

  if (task.turns > 0) {
    meta.push(el('span', { textContent: `${task.turns} turns` }))
  }

  const timeText = task.ended_at
    ? timeAgo(task.ended_at)
    : task.started_at
      ? timeAgo(task.started_at)
      : timeAgo(task.created_at)

  if (timeText) {
    meta.push(el('span', { textContent: timeText }))
  }

  const card = el(
    'div',
    {
      className: `task-card${isSelected ? ' selected' : ''}`,
      onClick: () => selectTask(task.id),
    },
    [
      el('div', { className: 'task-card-title', textContent: task.title }),
      el('div', { className: 'task-card-meta' }, meta),
    ]
  )

  return card
}
