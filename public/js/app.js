/**
 * Application entry point.
 *
 * Two-layer hash routing:
 *   #/                          — host picker (local + SSH hosts)
 *   #/<host>                    — project picker for that host
 *   #/<host>/<project>          — workspace
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
import { showHosts, showProjects, hideLanding } from './landing.js'
import { slugify, hostSlug, projectSlug, projectPath, navigateTo } from './router.js'

let workspaceReady = false

/** Find a project by host + project slug. */
function resolveProject(host, proj) {
  const candidates = state.projects.filter((p) => hostSlug(p) === host)
  return candidates.find((p) => projectSlug(p, state.projects) === proj)
    || candidates.find((p) => slugify(p.name) === proj)
    || null
}

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
  } catch {}

  const backBtn = document.getElementById('back-to-menu')
  if (backBtn) {
    backBtn.addEventListener('click', () => {
      const route = parseHash()
      if (route.view === 'workspace') {
        navigateTo(`/${route.host}`)
      } else {
        navigateTo('/')
      }
    })
  }

  window.addEventListener('hashchange', onHashChange)
  await onHashChange()
}

function parseHash() {
  const hash = (location.hash.replace(/^#/, '') || '/').replace(/\/+$/, '') || '/'
  if (hash === '/') return { view: 'hosts' }
  const parts = hash.replace(/^\//, '').split('/')
  if (parts.length === 1) return { view: 'projects', host: parts[0] }
  return { view: 'workspace', host: parts[0], project: parts.slice(1).join('/') }
}

async function onHashChange() {
  const route = parseHash()

  if (route.view === 'workspace') {
    const project = resolveProject(route.host, route.project)
    if (!project) {
      navigateTo(`/${route.host}`)
      return
    }
    await enterWorkspace(project.id)
  } else if (route.view === 'projects') {
    await enterProjectPicker(route.host)
  } else {
    await enterHostPicker()
  }
}

async function enterHostPicker() {
  try { state.projects = await fetchProjects() } catch {}
  document.body.classList.remove('workspace-active')
  await showHosts(state.projects, navigateTo)
}

async function enterProjectPicker(host) {
  try { state.projects = await fetchProjects() } catch {}
  document.body.classList.remove('workspace-active')
  await showProjects(host, state.projects, navigateTo)
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

async function onProjectSwitch(projectId) {
  const project = state.projects.find((p) => p.id === projectId)
  if (project) navigateTo(projectPath(project, state.projects))
}

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
