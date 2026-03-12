import { state } from './state.js'
import { fetchProjects, fetchSettings, updateSetting } from './api.js'
import { initSidebar, renderSidebar } from './sidebar.js'
import {
  initTerminalView,
  switchTerminalProject,
  fitTerminals,
  isInitialized,
  switchProvider,
  updateProviderLabels,
} from './terminal-view.js'
import { showHosts, showProjects, hideLanding } from './landing.js'
import { slugify, hostSlug, projectSlug, projectPath, navigateTo } from './router.js'

let workspaceReady = false

// --- Tab bar ---

const tabs = ['terminal', 'settings']

function initTabBar() {
  for (const tab of tabs) {
    const btn = document.getElementById(`tab-${tab}`)
    if (btn) btn.addEventListener('click', () => switchTab(tab))
  }
  document.addEventListener('keydown', (event) => {
    if (!(event.metaKey || event.ctrlKey)) return
    const idx = parseInt(event.key, 10) - 1
    if (idx >= 0 && idx < tabs.length) {
      event.preventDefault()
      switchTab(tabs[idx])
    }
  })
}

function switchTab(tab) {
  state.activeTab = tab
  for (const current of tabs) {
    const btn = document.getElementById(`tab-${current}`)
    const content = document.getElementById(`${current}-tab`)
    if (btn) btn.classList.toggle('active', current === tab)
    if (content) content.hidden = current !== tab
  }
  if (tab === 'terminal') {
    if (!isInitialized()) initTerminalView(state.activeProjectId)
    else fitTerminals()
  } else if (tab === 'settings') {
    loadSettings()
  }
}

// --- Settings ---

const cliProviderGroup = document.getElementById('cli-provider-group')
const cliSaveBtn = document.getElementById('cli-save-btn')
const cliStatusEl = document.getElementById('cli-status')

function loadSettings() {
  const radios = cliProviderGroup?.querySelectorAll('input[name="cli-provider"]')
  if (!radios) return
  for (const radio of radios) {
    radio.checked = radio.value === state.cliProvider
  }
}

if (cliSaveBtn) {
  cliSaveBtn.addEventListener('click', async () => {
    const selected = cliProviderGroup?.querySelector('input[name="cli-provider"]:checked')
    if (!selected) return
    try {
      await updateSetting('cli_provider', selected.value)
      state.cliProvider = selected.value
      updateProviderLabels()
      if (isInitialized()) switchProvider()
      cliStatusEl.textContent = 'Saved'
      cliStatusEl.className = 'settings-status success'
      setTimeout(() => { cliStatusEl.textContent = '' }, 3000)
    } catch (err) {
      cliStatusEl.textContent = err.message
      cliStatusEl.className = 'settings-status error'
      setTimeout(() => { cliStatusEl.textContent = '' }, 3000)
    }
  })
}

// --- Routing ---

function resolveProject(host, proj) {
  const candidates = state.projects.filter((p) => hostSlug(p) === host)
  return candidates.find((p) => projectSlug(p, state.projects) === proj)
    || candidates.find((p) => slugify(p.name) === proj)
    || null
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
    if (!project) { navigateTo(`/${route.host}`); return }
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

// --- Init ---

async function init() {
  try { state.projects = await fetchProjects() } catch { state.projects = [] }
  initSidebar(onProjectSwitch)
  initTabBar()
  try {
    const settings = await fetchSettings()
    if (settings.cli_provider) state.cliProvider = settings.cli_provider
  } catch {}

  const backBtn = document.getElementById('back-to-menu')
  if (backBtn) {
    backBtn.addEventListener('click', () => {
      const route = parseHash()
      if (route.view === 'workspace') navigateTo(`/${route.host}`)
      else navigateTo('/')
    })
  }

  window.addEventListener('hashchange', onHashChange)
  await onHashChange()
}

init()
