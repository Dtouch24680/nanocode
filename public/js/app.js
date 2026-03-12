/**
 * Application entry point.
 *
 * Uses hash-based routing:
 *   #/            — landing screen (workspace picker)
 *   #/project/ID  — workspace for a specific project
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
import { showLanding, hideLanding } from './landing.js'

let workspaceReady = false

async function init() {
  try {
    state.projects = await fetchProjects()
  } catch (err) {
    console.error('Failed to load projects:', err.message)
    state.projects = []
  }

  initSidebar(onProjectSwitch)
  initTabBar(onTabSwitch)

  try {
    const settings = await fetchSettings()
    if (settings.cli_provider) state.cliProvider = settings.cli_provider
  } catch {
    // non-critical
  }

  // Wire up back-to-menu button
  const backBtn = document.getElementById('back-to-menu')
  if (backBtn) {
    backBtn.addEventListener('click', () => navigateTo('/'))
  }

  // Handle initial route
  window.addEventListener('hashchange', onHashChange)
  await onHashChange()
}

/** Parse the current hash into a route. */
function parseHash() {
  const hash = location.hash.replace(/^#/, '') || '/'
  const projectMatch = hash.match(/^\/project\/(.+)$/)
  if (projectMatch) return { view: 'project', projectId: projectMatch[1] }
  return { view: 'landing' }
}

/** Navigate to a hash route. */
export function navigateTo(path) {
  location.hash = '#' + path
}

/** React to hash changes. */
async function onHashChange() {
  const route = parseHash()

  if (route.view === 'project') {
    const project = state.projects.find((p) => p.id === route.projectId)
    if (!project) {
      // Unknown project — go to landing
      navigateTo('/')
      return
    }
    await enterWorkspace(route.projectId)
  } else {
    await enterLanding()
  }
}

async function enterLanding() {
  // Refresh project list
  try {
    state.projects = await fetchProjects()
  } catch {}

  document.body.classList.remove('workspace-active')
  const { projectId, projects } = await showLanding(state.projects)
  state.projects = projects || state.projects

  if (projectId) {
    navigateTo(`/project/${projectId}`)
  }
}

async function enterWorkspace(projectId) {
  hideLanding()
  document.body.classList.add('workspace-active')
  state.activeProjectId = projectId
  localStorage.setItem('activeProjectId', projectId)

  renderSidebar()

  if (!workspaceReady) {
    workspaceReady = true
    await initTerminalView(projectId)
  } else {
    switchTerminalProject(projectId)
  }
}

/**
 * Called when the user switches projects in the sidebar.
 */
async function onProjectSwitch(projectId) {
  navigateTo(`/project/${projectId}`)
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
    return
  }

  if (tab === 'settings') {
    loadSettings()
  }
}

init()
