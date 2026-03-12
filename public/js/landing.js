/**
 * Landing screen — choose between local development and SSH remote hosts.
 * Shown before the workspace loads. Reads SSH config presets from the server.
 */

import { fetchSshHosts, fetchProjects, createProject } from './api.js'

let _resolve = null

/**
 * Show the landing screen overlay.
 * Resolves with the selected project ID when the user makes a choice.
 *
 * @param {Array} existingProjects — already-loaded projects list
 * @returns {Promise<{projectId: string, projects: Array}>}
 */
export async function showLanding(existingProjects) {
  const overlay = document.getElementById('landing-overlay')
  if (!overlay) return { projectId: existingProjects[0]?.id ?? null, projects: existingProjects }

  // Load SSH hosts in parallel
  let sshHosts = []
  try {
    sshHosts = await fetchSshHosts()
  } catch {
    // no SSH config or server error
  }

  // Build local project cards
  const grid = overlay.querySelector('.landing-grid')
  grid.textContent = ''

  // --- Local section ---
  const localSection = el('div', 'landing-section')
  localSection.appendChild(el('h2', 'landing-section-title', 'Local'))
  const localCards = el('div', 'landing-cards')

  // Existing local projects
  const localProjects = existingProjects.filter((p) => !p.ssh_host)
  for (const proj of localProjects) {
    const card = makeProjectCard(proj.name, proj.cwd, null)
    card.addEventListener('click', () => resolve(proj.id, existingProjects))
    localCards.appendChild(card)
  }

  // "New local project" card
  const newLocal = el('button', 'landing-card landing-card-new')
  newLocal.innerHTML = '<span class="landing-card-plus">+</span><span>New local project</span>'
  newLocal.addEventListener('click', () => {
    overlay.hidden = true
    document.getElementById('project-add')?.click()
  })
  localCards.appendChild(newLocal)
  localSection.appendChild(localCards)
  grid.appendChild(localSection)

  // --- Remote section ---
  const remoteProjects = existingProjects.filter((p) => !!p.ssh_host)

  if (sshHosts.length || remoteProjects.length) {
    const remoteSection = el('div', 'landing-section')
    remoteSection.appendChild(el('h2', 'landing-section-title', 'SSH Remote'))
    const remoteCards = el('div', 'landing-cards')

    for (const proj of remoteProjects) {
      const subtitle = `${proj.ssh_user || 'root'}@${proj.ssh_host}`
      const card = makeProjectCard(proj.name, subtitle, proj.cwd)
      card.querySelector('.landing-card-icon').textContent = '\u{1F5A5}'
      card.addEventListener('click', () => resolve(proj.id, existingProjects))
      remoteCards.appendChild(card)
    }

    // SSH config hosts without an existing project
    const usedHosts = new Set(remoteProjects.map((p) => p.ssh_host))
    for (const host of sshHosts) {
      if (usedHosts.has(host.hostname)) continue
      const label = host.name
      const subtitle = `${host.user || 'root'}@${host.hostname}`
      const card = makeProjectCard(label, subtitle, null)
      card.querySelector('.landing-card-icon').textContent = '\u{1F5A5}'
      card.classList.add('landing-card-preset')
      card.addEventListener('click', () => connectSshHost(host))
      remoteCards.appendChild(card)
    }

    remoteSection.appendChild(remoteCards)
    grid.appendChild(remoteSection)
  }

  // Show overlay
  overlay.hidden = false

  // Skip button
  const skipBtn = overlay.querySelector('.landing-skip')
  if (skipBtn) {
    if (existingProjects.length) {
      skipBtn.hidden = false
      skipBtn.onclick = () => resolve(existingProjects[0].id, existingProjects)
    } else {
      skipBtn.hidden = true
    }
  }

  return new Promise((res) => {
    _resolve = res
  })
}

/** Hide the landing overlay without resolving (used by router). */
export function hideLanding() {
  const overlay = document.getElementById('landing-overlay')
  if (overlay) overlay.hidden = true
}

function resolve(projectId, projects) {
  hideLanding()
  if (_resolve) {
    const cb = _resolve
    _resolve = null
    cb({ projectId, projects })
  }
}

function el(tag, className, text) {
  const e = document.createElement(tag)
  if (className) e.className = className
  if (text) e.textContent = text
  return e
}

function makeProjectCard(title, subtitle, detail) {
  const card = el('button', 'landing-card')
  const icon = el('span', 'landing-card-icon', '\u{1F4C1}')
  const body = el('div', 'landing-card-body')
  body.appendChild(el('span', 'landing-card-title', title))
  if (subtitle) body.appendChild(el('span', 'landing-card-subtitle', subtitle))
  if (detail) body.appendChild(el('span', 'landing-card-detail', detail))
  card.appendChild(icon)
  card.appendChild(body)
  return card
}

async function connectSshHost(host) {
  const dir = prompt(`Remote directory on ${host.hostname}:`, `/home/${host.user || 'root'}`)
  if (!dir) return

  const name = host.name || host.hostname
  try {
    const project = await createProject({
      name,
      cwd: dir,
      ssh_host: host.hostname,
      ssh_user: host.user || undefined,
      ssh_port: host.port || undefined,
      ssh_key: host.identityFile || undefined,
    })
    const projects = await fetchProjects()
    resolve(project.id, projects)
  } catch (err) {
    alert('Failed to create project: ' + err.message)
  }
}
