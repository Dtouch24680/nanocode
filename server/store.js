/**
 * JSON file data layer for projects, settings, and terminal session metadata.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'fs'
import { randomUUID } from 'crypto'

function emptyData() {
  return { projects: [], settings: {}, archivedSessions: {}, managedSessions: {} }
}

export function createStore(filePath = ':memory:') {
  const inMemory = filePath === ':memory:'
  let data = emptyData()

  if (!inMemory && existsSync(filePath)) {
    try { data = JSON.parse(readFileSync(filePath, 'utf-8')) } catch { data = emptyData() }
    // Ensure all keys exist (forward compat)
    if (!data.projects) data.projects = []
    if (!data.settings) data.settings = {}
    if (!data.archivedSessions) data.archivedSessions = {}
    if (!data.managedSessions) data.managedSessions = {}
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
    delete data.archivedSessions[id]
    delete data.managedSessions[id]
    save()
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

  // --- Session metadata ---

  function archiveSession(projectId, sessionId) {
    if (!data.archivedSessions[projectId]) data.archivedSessions[projectId] = []
    const list = data.archivedSessions[projectId]
    if (!list.some((s) => s.id === sessionId)) {
      list.push({ id: sessionId, archivedAt: Date.now() })
      save()
    }
  }

  function unarchiveSession(projectId, sessionId) {
    if (!data.archivedSessions[projectId]) return
    data.archivedSessions[projectId] = data.archivedSessions[projectId].filter((s) => s.id !== sessionId)
    save()
  }

  function listArchivedSessions(projectId) {
    return (data.archivedSessions[projectId] || []).map((s) => s.id)
  }

  function markSessionManaged(projectId, sessionId) {
    if (!data.managedSessions[projectId]) data.managedSessions[projectId] = []
    const list = data.managedSessions[projectId]
    if (!list.includes(sessionId)) {
      list.push(sessionId)
      save()
    }
  }

  function listManagedSessions(projectId) {
    return [...(data.managedSessions[projectId] || [])]
  }

  function close() { /* no-op for JSON store */ }

  return {
    getSetting, setSetting, getAllSettings,
    createProject, getProject, listProjects, removeProject,
    migrateProjectsJson, ensureStarterProject,
    archiveSession, unarchiveSession, listArchivedSessions,
    markSessionManaged, listManagedSessions,
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
