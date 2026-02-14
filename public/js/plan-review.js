/**
 * Renders the plan review panel with confirm/revise actions.
 *
 * Architecture: server/docs/plan-review-flow.md
 */

import { md } from './render.js'
import { confirmPlan, revisePlan } from './api.js'
import { selectTask } from './state.js'

const panel = document.getElementById('plan-review-panel')
const titleEl = document.getElementById('plan-title')
const contentEl = document.getElementById('plan-content')
const feedbackEl = document.getElementById('plan-feedback')

// Close button
document.getElementById('plan-close').addEventListener('click', () => {
  selectTask(null)
})

// Confirm button
document.getElementById('plan-confirm').addEventListener('click', async () => {
  const taskId = panel.dataset.taskId
  if (!taskId) return

  try {
    await confirmPlan(taskId)
    selectTask(null)
  } catch (err) {
    console.error('Confirm failed:', err.message)
  }
})

// Revise button
document.getElementById('plan-revise-btn').addEventListener('click', async () => {
  const taskId = panel.dataset.taskId
  const feedback = feedbackEl.value.trim()
  if (!taskId || !feedback) return

  try {
    await revisePlan(taskId, { feedback })
    feedbackEl.value = ''
    selectTask(null)
  } catch (err) {
    console.error('Revise failed:', err.message)
  }
})

/**
 * Show the plan review panel for a task in review status.
 *
 * @param {object} task
 */
export function showPlanReview(task) {
  // Hide detail panel
  document.getElementById('detail-panel').hidden = true

  panel.dataset.taskId = task.id
  titleEl.textContent = `Plan: ${task.title}`
  contentEl.innerHTML = md(task.plan_result || '_No plan output._')
  feedbackEl.value = ''
  panel.hidden = false
}
