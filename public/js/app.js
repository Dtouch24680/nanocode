/**
 * Application entry point.
 *
 * Loads projects, selects active project, initializes sidebar + tabs,
 * connects WebSocket, and wires up both task and terminal views.
 *
 * Architecture: public/docs/state-management.md#initial-load
 */

import { state } from './state.js'
import { connect } from './ws.js'
import { fetchProjects, fetchTasks, fetchEvents } from './api.js'
import { renderBoard } from './task-board.js'
import { initForm } from './task-form.js'
import { initSidebar, renderSidebar } from './sidebar.js'
import { initTabBar, switchTab } from './tab-bar.js'
import { initTerminalView, switchTerminalProject, fitTerminals, isInitialized } from './terminal-view.js'
import { loadSettings } from './settings.js'

async function init() {
  // Initialize form
  initForm()

  // Load projects
  try {
    state.projects = await fetchProjects()
  } catch (err) {
    console.error('Failed to load projects:', err.message)
    state.projects = []
  }

  // Restore or pick active project
  const lastId = localStorage.getItem('activeProjectId')
  state.activeProjectId =
    lastId && state.projects.some((p) => p.id === lastId)
      ? lastId
      : state.projects[0]?.id ?? null

  // Initialize sidebar
  initSidebar(onProjectSwitch)
  renderSidebar()

  // Initialize tab bar
  initTabBar(onTabSwitch)

  // Load tasks for active project
  await loadTasks()

  // Connect codebuilder WebSocket
  connect()
}

/**
 * Load tasks for the active project and render the board.
 */
async function loadTasks() {
  try {
    state.tasks = await fetchTasks(state.activeProjectId)
  } catch (err) {
    console.error('Failed to load tasks:', err.message)
    state.tasks = []
  }

  // Fetch events for running tasks
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

  renderBoard()
}

/**
 * Called when the user switches projects in the sidebar.
 */
async function onProjectSwitch(projectId) {
  state.activeProjectId = projectId
  state.selectedTaskId = null
  state.events.clear()

  // Hide panels
  document.getElementById('detail-panel').hidden = true
  document.getElementById('plan-review-panel').hidden = true

  // Reload tasks for new project
  await loadTasks()

  // Update terminal if initialized
  if (isInitialized()) {
    switchTerminalProject(projectId)
  }
}

/**
 * Called when the user switches tabs.
 */
function onTabSwitch(tab) {
  if (tab === 'terminal') {
    if (!isInitialized()) {
      initTerminalView(state.activeProjectId)
    } else {
      fitTerminals()
    }
  } else if (tab === 'settings') {
    loadSettings()
  }
}

init()
