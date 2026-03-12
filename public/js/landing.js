/**
 * Landing screen — two-layer navigation.
 *   Layer 1: Host picker (local machine + SSH remote hosts)
 *   Layer 2: Project picker (projects within a selected host)
 */

import { fetchSshHosts, fetchProjects, createProject } from './api.js'
import { slugify, hostSlug, projectPath } from './router.js'

/** Show the host picker (layer 1). */
export async function showHosts(projects, navigate) {
  const overlay = document.getElementById('landing-overlay')
  if (!overlay) return

  let sshHosts = []
  try { sshHosts = await fetchSshHosts() } catch {}

  const grid = overlay.querySelector('.landing-grid')
  grid.textContent = ''

  // Title + breadcrumb
  setLandingHeader(overlay, 'Select a host', null)

  const cards = el('div', 'landing-cards')

  // Local host card
  const localCount = projects.filter((p) => !p.ssh_host).length
  const localCard = makeHostCard('Local', 'This machine', `${localCount} project${localCount !== 1 ? 's' : ''}`)
  localCard.addEventListener('click', () => navigate('/local'))
  cards.appendChild(localCard)

  // Group remote projects by ssh_host
  const remoteHosts = new Map()
  for (const p of projects) {
    if (!p.ssh_host) continue
    const slug = hostSlug(p)
    if (!remoteHosts.has(slug)) {
      remoteHosts.set(slug, {
        hostname: p.ssh_host,
        user: p.ssh_user,
        slug,
        count: 0,
      })
    }
    remoteHosts.get(slug).count++
  }

  // Add SSH config hosts that have no projects yet
  for (const host of sshHosts) {
    const slug = slugify(host.hostname)
    if (!remoteHosts.has(slug)) {
      remoteHosts.set(slug, {
        hostname: host.hostname,
        user: host.user,
        identityFile: host.identityFile,
        port: host.port,
        configName: host.name,
        slug,
        count: 0,
      })
    }
  }

  for (const [, host] of remoteHosts) {
    const label = host.configName || host.hostname
    const subtitle = `${host.user || 'root'}@${host.hostname}`
    const detail = host.count ? `${host.count} project${host.count !== 1 ? 's' : ''}` : 'from SSH config'
    const card = makeHostCard(label, subtitle, detail)
    card.querySelector('.landing-card-icon').textContent = '\u{1F5A5}'
    if (!host.count) card.classList.add('landing-card-preset')
    card.addEventListener('click', () => navigate(`/${host.slug}`))
    cards.appendChild(card)
  }

  grid.appendChild(cards)
  overlay.hidden = false
}

/** Show the project picker for a specific host (layer 2). */
export async function showProjects(host, projects, navigate) {
  const overlay = document.getElementById('landing-overlay')
  if (!overlay) return

  const grid = overlay.querySelector('.landing-grid')
  grid.textContent = ''

  const isLocal = host === 'local'
  const hostProjects = projects.filter((p) => hostSlug(p) === host)

  // Header with back breadcrumb
  const hostLabel = isLocal ? 'Local' : (hostProjects[0]?.ssh_host || host)
  setLandingHeader(overlay, hostLabel, () => navigate('/'))

  const cards = el('div', 'landing-cards')

  for (const proj of hostProjects) {
    const subtitle = isLocal ? proj.cwd : proj.cwd
    const card = makeProjectCard(proj.name, subtitle)
    card.addEventListener('click', () => {
      navigate(projectPath(proj, projects))
    })
    cards.appendChild(card)
  }

  // "New project" card
  const newCard = el('button', 'landing-card landing-card-new')
  newCard.innerHTML = '<span class="landing-card-plus">+</span><span>New project</span>'
  newCard.addEventListener('click', () => {
    if (isLocal) {
      overlay.hidden = true
      document.getElementById('project-add')?.click()
    } else {
      addRemoteProject(host, hostProjects, projects, navigate)
    }
  })
  cards.appendChild(newCard)

  grid.appendChild(cards)
  overlay.hidden = false
}

/** Hide the landing overlay. */
export function hideLanding() {
  const overlay = document.getElementById('landing-overlay')
  if (overlay) overlay.hidden = true
}

// --- Internal helpers ---

function setLandingHeader(overlay, title, onBack) {
  let header = overlay.querySelector('.landing-header')
  if (!header) {
    header = el('div', 'landing-header')
    const container = overlay.querySelector('.landing-container')
    const grid = container.querySelector('.landing-grid')
    container.insertBefore(header, grid)
  }
  header.textContent = ''

  if (onBack) {
    const backBtn = el('button', 'landing-back')
    backBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>'
    backBtn.addEventListener('click', onBack)
    header.appendChild(backBtn)
  }

  header.appendChild(el('h2', 'landing-header-title', title))
}

function el(tag, className, text) {
  const e = document.createElement(tag)
  if (className) e.className = className
  if (text) e.textContent = text
  return e
}

function makeHostCard(title, subtitle, detail) {
  const card = el('button', 'landing-card')
  const icon = el('span', 'landing-card-icon', '\u{1F4BB}')
  const body = el('div', 'landing-card-body')
  body.appendChild(el('span', 'landing-card-title', title))
  if (subtitle) body.appendChild(el('span', 'landing-card-subtitle', subtitle))
  if (detail) body.appendChild(el('span', 'landing-card-detail', detail))
  card.appendChild(icon)
  card.appendChild(body)
  return card
}

function makeProjectCard(title, subtitle) {
  const card = el('button', 'landing-card')
  const icon = el('span', 'landing-card-icon', '\u{1F4C1}')
  const body = el('div', 'landing-card-body')
  body.appendChild(el('span', 'landing-card-title', title))
  if (subtitle) body.appendChild(el('span', 'landing-card-subtitle', subtitle))
  card.appendChild(icon)
  card.appendChild(body)
  return card
}

async function addRemoteProject(host, hostProjects, allProjects, navigate) {
  // Get SSH details from an existing project on this host, or from config
  const existing = hostProjects[0]
  const hostname = existing?.ssh_host || host
  const user = existing?.ssh_user || 'root'
  const port = existing?.ssh_port || null
  const key = existing?.ssh_key || null

  const dir = prompt(`Remote directory on ${hostname}:`, `/home/${user}`)
  if (!dir) return

  const name = prompt('Project name:', dir.split('/').filter(Boolean).pop() || 'project')
  if (!name) return

  try {
    const project = await createProject({
      name,
      cwd: dir,
      ssh_host: hostname,
      ssh_user: user || undefined,
      ssh_port: port || undefined,
      ssh_key: key || undefined,
    })
    const projects = await fetchProjects()
    navigate(projectPath(project, projects))
  } catch (err) {
    alert('Failed to create project: ' + err.message)
  }
}
