/**
 * Sidebar — project list with add/delete, active project indicator.
 */

import { state } from './state.js'
import { fetchProjects, createProject, deleteProject, fetchDir } from './api.js'

let _onProjectSwitch = null

/**
 * Initialize the sidebar.
 * @param {function} onProjectSwitch — callback(projectId) when project changes
 */
export function initSidebar(onProjectSwitch) {
  _onProjectSwitch = onProjectSwitch

  // Sidebar toggle (mobile hamburger)
  const sidebar = document.getElementById('sidebar')
  const toggleBtn = document.getElementById('sidebar-toggle')
  if (toggleBtn && sidebar) {
    // Create backdrop element for mobile overlay
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

  form.addEventListener('submit', async (e) => {
    e.preventDefault()
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

export function renderSidebar() {
  const container = document.getElementById('sidebar-projects')
  container.textContent = ''

  // Count tasks per project
  const taskCounts = new Map()
  const runningCounts = new Map()
  for (const task of state.tasks) {
    if (task.project_id) {
      taskCounts.set(task.project_id, (taskCounts.get(task.project_id) || 0) + 1)
      if (task.status === 'running') {
        runningCounts.set(task.project_id, (runningCounts.get(task.project_id) || 0) + 1)
      }
    }
  }

  for (const project of state.projects) {
    const item = document.createElement('button')
    item.className = 'sidebar-project' + (project.id === state.activeProjectId ? ' active' : '')
    item.type = 'button'

    const name = document.createElement('span')
    name.className = 'sidebar-project-name'
    name.textContent = project.name
    item.appendChild(name)

    // Task count badge
    const running = runningCounts.get(project.id) || 0
    const total = taskCounts.get(project.id) || 0
    if (running > 0) {
      const badge = document.createElement('span')
      badge.className = 'sidebar-project-badge running'
      badge.textContent = running
      badge.title = `${running} running`
      item.appendChild(badge)
    } else if (total > 0 && project.id !== state.activeProjectId) {
      const badge = document.createElement('span')
      badge.className = 'sidebar-project-badge'
      badge.textContent = total
      item.appendChild(badge)
    }

    item.addEventListener('click', () => switchProject(project.id))

    // Delete button (only if more than one project)
    if (state.projects.length > 1) {
      const del = document.createElement('span')
      del.className = 'sidebar-project-del'
      del.textContent = '\u00d7'
      del.addEventListener('click', async (e) => {
        e.stopPropagation()
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
  try { localStorage.setItem('activeProjectId', projectId) } catch {}
  renderSidebar()

  // Close mobile sidebar
  const sidebar = document.getElementById('sidebar')
  const backdrop = document.querySelector('.sidebar-backdrop')
  if (sidebar) sidebar.classList.remove('open')
  if (backdrop) backdrop.classList.remove('open')

  if (_onProjectSwitch) _onProjectSwitch(projectId)
}

// --- Add project dialog + folder browser ---

let browsePath = ''

function openAddDialog() {
  document.getElementById('proj-name').value = ''
  document.getElementById('proj-cwd').value = ''
  document.getElementById('proj-cwd-hint').textContent = 'Click "Select this folder" to set the project path.'
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
  } catch (e) {
    console.error(e)
  }
}

function renderBreadcrumb(path) {
  const el = document.getElementById('folder-breadcrumb')
  if (!el) return
  el.textContent = ''
  const homeLink = document.createElement('a')
  homeLink.href = '#'
  homeLink.textContent = 'Home'
  homeLink.addEventListener('click', (e) => { e.preventDefault(); loadFolder('') })
  el.appendChild(homeLink)
  if (!path) return
  const parts = path.replace(/\/$/, '').split('/').filter(Boolean)
  for (let i = 0; i < parts.length; i++) {
    const segPath = '/' + parts.slice(0, i + 1).join('/')
    el.appendChild(document.createTextNode(' / '))
    const a = document.createElement('a')
    a.href = '#'
    a.textContent = parts[i]
    a.addEventListener('click', (e) => { e.preventDefault(); loadFolder(segPath) })
    el.appendChild(a)
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
