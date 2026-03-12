/**
 * Application entry point.
 *
 * Shows a landing screen for workspace selection, then loads projects,
 * restores the active workspace, and wires up the terminal and settings views.
 *
 * Architecture: public/docs/state-management.md#initial-load
 */

import { state } from './state.js'
import { fetchProjects, fetchSettings } from './api.js'
import { initSidebar, renderSidebar } from './sidebar.js'
import { initTabBar } from './tab-bar.js'
import {
  initTerminalView,
  switchTerminalProject,
  fitTerminals,
  isInitialized,
} from './terminal-view.js'
import { loadSettings } from './settings.js'
import { showLanding } from './landing.js'

async function init() {
  try {
    state.projects = await fetchProjects()
  } catch (err) {
    console.error('Failed to load projects:', err.message)
    state.projects = []
  }

  // Show landing screen
  const { projectId, projects } = await showLanding(state.projects)
  state.projects = projects || state.projects

  // Determine active project
  const lastId = localStorage.getItem('activeProjectId')
  state.activeProjectId = projectId
    || (lastId && state.projects.some((p) => p.id === lastId) ? lastId : null)
    || (state.projects[0]?.id ?? null)

  initSidebar(onProjectSwitch)
  renderSidebar()

  initTabBar(onTabSwitch)

  try {
    const settings = await fetchSettings()
    if (settings.cli_provider) state.cliProvider = settings.cli_provider
  } catch {
    // non-critical, defaults to claude
  }

  await initTerminalView(state.activeProjectId)
}

/**
 * Called when the user switches projects in the sidebar.
 *
 * Architecture: public/docs/state-management.md#project-switching
 */
async function onProjectSwitch(projectId) {
  state.activeProjectId = projectId

  if (isInitialized()) {
    switchTerminalProject(projectId)
  } else {
    await initTerminalView(projectId)
  }
}

/**
 * Called when the user switches tabs.
 *
 * Architecture: public/docs/state-management.md#tab-switching
 */
function onTabSwitch(tab) {
  if (tab === 'terminal') {
    if (!isInitialized()) {
      initTerminalView(state.activeProjectId)
    } else {
      fitTerminals()
    }
    return
  }

  if (tab === 'settings') {
    loadSettings()
  }
}

init()
