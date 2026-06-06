/**
 * JSON file data layer for projects and settings.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'fs'
import { randomUUID } from 'crypto'

const TAB_TYPES = new Set(['bash', 'claude', 'codex', 'agent', 'opencode'])

function emptyData() {
  return { projects: [], settings: {}, tabs: {} }
}

export function createStore(filePath = ':memory:') {
  const inMemory = filePath === ':memory:'
  let data = emptyData()

  if (!inMemory && existsSync(filePath)) {
    try { data = JSON.parse(readFileSync(filePath, 'utf-8')) } catch { data = emptyData() }
    if (!data.projects) data.projects = []
    if (!data.settings) data.settings = {}
    if (!data.tabs || typeof data.tabs !== 'object') data.tabs = {}
    // Forward-compat: drop deprecated keys silently
    delete data.archivedSessions
    delete data.managedSessions
  }

  function save() {
    if (inMemory) return
    writeFileSync(filePath, JSON.stringify(data, null, 2))
  }

  // --- Settings ---

  function getSetting(key) {
    return data.settings[key] ?? null
  }

  function setSetting(key, value) {
    data.settings[key] = value
    save()
  }

  function getAllSettings() {
    return { ...data.settings }
  }

  // --- Projects ---

  function createProject(name, cwd, existingId = null, ssh = {}) {
    const id = existingId || randomUUID()
    const project = {
      id,
      name,
      cwd,
      created_at: Date.now(),
      ssh_host: ssh.host || null,
      ssh_user: ssh.user || null,
      ssh_port: ssh.port || null,
      ssh_key: ssh.key || null,
    }
    data.projects.push(project)
    save()
    return { ...project }
  }

  function getProject(id) {
    const p = data.projects.find((p) => p.id === id)
    return p ? { ...p } : undefined
  }

  function listProjects() {
    return data.projects.map((p) => ({ ...p }))
  }

  function removeProject(id) {
    data.projects = data.projects.filter((p) => p.id !== id)
    delete data.tabs[id]
    save()
  }

  // --- Tabs (per-project, persisted; PTYs live in-memory keyed by tabId) ---

  function listTabs(projectId) {
    return (data.tabs[projectId] || []).map((t) => ({ ...t }))
  }

  function createTab(projectId, opts = {}) {
    if (!data.tabs[projectId]) data.tabs[projectId] = []
    const id = opts.id || randomUUID().slice(0, 8)
    const existing = data.tabs[projectId]
    const type = TAB_TYPES.has(opts.type) ? opts.type : 'bash'
    const n = existing.filter((t) => (t.type || 'bash') === type).length + 1
    const tab = {
      id,
      label: opts.label || `${type} ${n}`,
      type,
      createdAt: Date.now(),
    }
    if (type === 'claude') {
      tab.claudeSessionId = opts.claudeSessionId || randomUUID()
      tab.claudeSessionStarted = false
    } else if (type === 'codex') {
      tab.codexThreadId = opts.codexThreadId || null
    }
    existing.push(tab)
    save()
    return { ...tab }
  }

  function removeTab(projectId, tabId) {
    if (!data.tabs[projectId]) return false
    const before = data.tabs[projectId].length
    data.tabs[projectId] = data.tabs[projectId].filter((t) => t.id !== tabId)
    if (data.tabs[projectId].length < before) {
      save()
      return true
    }
    return false
  }

  function renameTab(projectId, tabId, label) {
    if (!data.tabs[projectId]) return null
    const tab = data.tabs[projectId].find((t) => t.id === tabId)
    if (!tab) return null
    tab.label = label
    save()
    return { ...tab }
  }

  function hasTab(projectId, tabId) {
    if (!data.tabs[projectId]) return false
    return data.tabs[projectId].some((t) => t.id === tabId)
  }

  function getTab(projectId, tabId) {
    if (!data.tabs[projectId]) return null
    const tab = data.tabs[projectId].find((t) => t.id === tabId)
    return tab ? { ...tab } : null
  }

  function updateTabMetadata(projectId, tabId, patch = {}) {
    if (!data.tabs[projectId]) return null
    const tab = data.tabs[projectId].find((t) => t.id === tabId)
    if (!tab) return null
    const allowed = ['claudeSessionId', 'claudeSessionStarted', 'codexThreadId']
    let changed = false
    for (const key of allowed) {
      if (Object.prototype.hasOwnProperty.call(patch, key) && tab[key] !== patch[key]) {
        tab[key] = patch[key]
        changed = true
      }
    }
    if (changed) save()
    return { ...tab }
  }

  function migrateProjectsJson(jsonPath) {
    if (!existsSync(jsonPath)) return
    try {
      const projects = JSON.parse(readFileSync(jsonPath, 'utf-8'))
      const existingIds = new Set(data.projects.map((p) => p.id))
      const existingCwds = new Set(data.projects.map((p) => p.cwd))
      for (const project of projects) {
        if (!existingIds.has(project.id) && !existingCwds.has(project.cwd)) {
          data.projects.push({
            id: project.id,
            name: project.name,
            cwd: project.cwd,
            created_at: Date.now(),
            ssh_host: null, ssh_user: null, ssh_port: null, ssh_key: null,
          })
        }
      }
      save()
      renameSync(jsonPath, `${jsonPath}.bak`)
    } catch { /* ignore migration errors */ }
  }

  function ensureStarterProject() {
    if (data.projects.length > 0) return
    const cwd = process.cwd()
    const name = cwd.split('/').filter(Boolean).pop() || 'project'
    createProject(name, cwd)
  }

  function close() { /* no-op for JSON store */ }

  return {
    getSetting, setSetting, getAllSettings,
    createProject, getProject, listProjects, removeProject,
    migrateProjectsJson, ensureStarterProject,
    listTabs, createTab, removeTab, renameTab, hasTab, getTab, updateTabMetadata,
    close,
  }
}

let _instance = null

export function getStore(filePath = 'data/nanocode.json') {
  if (!_instance) {
    const dir = filePath.substring(0, filePath.lastIndexOf('/'))
    if (dir) mkdirSync(dir, { recursive: true })
    _instance = createStore(filePath)
  }
  return _instance
}
