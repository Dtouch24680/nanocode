/**
 * Sidebar — project list with add/delete, active project indicator.
 *
 * Architecture: docs/architecture.md#frontend-architecture
 */

import { state } from './state.js'
import { fetchProjects, createProject, deleteProject, fetchDir } from './api.js'

let _onProjectSwitch = null
let browsePath = ''

/**
 * Initialize the sidebar.
 *
 * Architecture: docs/architecture.md#frontend-architecture
 */
export function initSidebar(onProjectSwitch) {
  _onProjectSwitch = onProjectSwitch

  const sidebar = document.getElementById('sidebar')
  const toggleBtn = document.getElementById('sidebar-toggle')
  if (toggleBtn && sidebar) {
    let backdrop = document.querySelector('.sidebar-backdrop')
    if (!backdrop) {
      backdrop = document.createElement('div')
      backdrop.className = 'sidebar-backdrop'
      sidebar.parentNode.insertBefore(backdrop, sidebar.nextSibling)
    }
    toggleBtn.addEventListener('click', () => {
      const open = sidebar.classList.toggle('open')
      backdrop.classList.toggle('open', open)
    })
    backdrop.addEventListener('click', () => {
      sidebar.classList.remove('open')
      backdrop.classList.remove('open')
    })
  }

  document.getElementById('project-add').addEventListener('click', openAddDialog)

  const dialog = document.getElementById('add-project-dialog')
  const form = document.getElementById('add-project-form')
  const cancelBtn = document.getElementById('proj-cancel')
  const selectFolderBtn = document.getElementById('folder-select-btn')

  cancelBtn?.addEventListener('click', () => dialog.close())
  selectFolderBtn?.addEventListener('click', selectCurrentFolder)

  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    const name = document.getElementById('proj-name').value.trim()
    const cwd = document.getElementById('proj-cwd').value.trim()
    if (!name || !cwd) return

    try {
      const project = await createProject({ name, cwd })
      state.projects = await fetchProjects()
      renderSidebar()
      switchProject(project.id)
      dialog.close()
    } catch (err) {
      console.error(err)
    }
  })
}

/**
 * Render the list of available projects.
 *
 * Architecture: docs/architecture.md#frontend-architecture
 */
export function renderSidebar() {
  const container = document.getElementById('sidebar-projects')
  if (!container) return

  container.textContent = ''

  for (const project of state.projects) {
    const item = document.createElement('button')
    item.className =
      'sidebar-project' + (project.id === state.activeProjectId ? ' active' : '')
    item.type = 'button'

    const name = document.createElement('span')
    name.className = 'sidebar-project-name'
    name.textContent = project.name
    item.appendChild(name)

    item.addEventListener('click', () => switchProject(project.id))

    if (state.projects.length > 1) {
      const del = document.createElement('span')
      del.className = 'sidebar-project-del'
      del.textContent = 'x'
      del.addEventListener('click', async (event) => {
        event.stopPropagation()
        if (!confirm('Delete this project? Terminal sessions will end.')) return
        await deleteProject(project.id)
        state.projects = await fetchProjects()
        if (state.activeProjectId === project.id) {
          const next = state.projects[0]?.id || null
          switchProject(next)
        }
        renderSidebar()
      })
      item.appendChild(del)
    }

    container.appendChild(item)
  }
}

function switchProject(projectId) {
  if (projectId === state.activeProjectId) return
  state.activeProjectId = projectId
  try {
    localStorage.setItem('activeProjectId', projectId)
  } catch {}
  renderSidebar()

  const sidebar = document.getElementById('sidebar')
  const backdrop = document.querySelector('.sidebar-backdrop')
  if (sidebar) sidebar.classList.remove('open')
  if (backdrop) backdrop.classList.remove('open')

  if (_onProjectSwitch) _onProjectSwitch(projectId)
}

function openAddDialog() {
  document.getElementById('proj-name').value = ''
  document.getElementById('proj-cwd').value = ''
  document.getElementById('proj-cwd-hint').textContent =
    'Click "Select this folder" to set the project path.'
  browsePath = ''
  loadFolder('')
  document.getElementById('add-project-dialog').showModal()
}

function selectCurrentFolder() {
  if (!browsePath) return
  document.getElementById('proj-cwd').value = browsePath
  const segments = browsePath.replace(/\/$/, '').split('/').filter(Boolean)
  const name = segments.length ? segments[segments.length - 1] : ''
  const nameInput = document.getElementById('proj-name')
  if (name && !nameInput.value.trim()) nameInput.value = name
  document.getElementById('proj-cwd-hint').textContent = browsePath
}

async function loadFolder(path) {
  browsePath = path
  try {
    const data = await fetchDir(path || undefined)
    browsePath = data.path
    renderBreadcrumb(data.path)
    renderFolderList(data.entries || [], data.path)
    const current = document.getElementById('folder-current')
    if (current) current.textContent = data.path || '(home)'
  } catch (err) {
    console.error(err)
  }
}

function renderBreadcrumb(path) {
  const el = document.getElementById('folder-breadcrumb')
  if (!el) return
  el.textContent = ''

  const homeLink = document.createElement('a')
  homeLink.href = '#'
  homeLink.textContent = 'Home'
  homeLink.addEventListener('click', (event) => {
    event.preventDefault()
    loadFolder('')
  })
  el.appendChild(homeLink)

  if (!path) return
  const parts = path.replace(/\/$/, '').split('/').filter(Boolean)
  for (let i = 0; i < parts.length; i++) {
    const segPath = '/' + parts.slice(0, i + 1).join('/')
    el.appendChild(document.createTextNode(' / '))
    const link = document.createElement('a')
    link.href = '#'
    link.textContent = parts[i]
    link.addEventListener('click', (event) => {
      event.preventDefault()
      loadFolder(segPath)
    })
    el.appendChild(link)
  }
}

function renderFolderList(entries, currentPath) {
  const el = document.getElementById('folder-list')
  if (!el) return
  el.textContent = ''

  for (const entry of entries) {
    if (!entry.isDir) continue
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.textContent = entry.name
    const nextPath = currentPath ? `${currentPath}/${entry.name}` : entry.name
    btn.addEventListener('click', () => loadFolder(nextPath))
    el.appendChild(btn)
  }
}
