/**
 * Application entry point.
 *
 * Initializes state from REST API, connects WebSocket, sets up form.
 *
 * Architecture: public/docs/state-management.md#initial-load
 */

import { state } from './state.js'
import { connect } from './ws.js'
import { fetchTasks, fetchEvents } from './api.js'
import { renderBoard } from './task-board.js'
import { initForm } from './task-form.js'

async function init() {
  // Initialize form
  initForm()

  // Load initial tasks
  try {
    state.tasks = await fetchTasks()
  } catch (err) {
    console.error('Failed to load tasks:', err.message)
    state.tasks = []
  }

  // Fetch events for running tasks (to replay on detail open)
  for (const task of state.tasks) {
    if (task.status === 'running') {
      try {
        const events = await fetchEvents(task.id)
        state.events.set(task.id, events)
      } catch {
        // non-critical
      }
    }
  }

  // Render initial board
  renderBoard()

  // Connect WebSocket
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
  connect(`${protocol}//${location.host}`)

  // Set default cwd to current page URL hint (or empty)
  const cwdInput = document.getElementById('task-cwd')
  if (!cwdInput.value) {
    cwdInput.value = '/storage/home/syzs/codebuilder'
  }
}

init()
