/**
 * SQLite data layer for projects, settings, and terminal session metadata.
 *
 * Architecture: docs/architecture.md#data-model
 */

import Database from 'better-sqlite3'
import { existsSync, mkdirSync, readFileSync, renameSync } from 'fs'
import { ulid } from 'ulid'

/**
 * Create a store instance backed by the given SQLite database path.
 *
 * Architecture: docs/architecture.md#data-model
 */
export function createStore(dbPath = ':memory:') {
  const db = new Database(dbPath)

  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')

  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      cwd        TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      ssh_host   TEXT,
      ssh_user   TEXT,
      ssh_port   INTEGER,
      ssh_key    TEXT
    );

    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS archived_sessions (
      project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      session_id  TEXT NOT NULL,
      archived_at INTEGER NOT NULL,
      PRIMARY KEY (project_id, session_id)
    );

    CREATE TABLE IF NOT EXISTS managed_sessions (
      project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      session_id  TEXT NOT NULL,
      PRIMARY KEY (project_id, session_id)
    );
  `)

  // Migrate existing databases: add SSH columns if missing
  const cols = db.pragma('table_info(projects)').map((c) => c.name)
  if (!cols.includes('ssh_host')) {
    db.exec(`
      ALTER TABLE projects ADD COLUMN ssh_host TEXT;
      ALTER TABLE projects ADD COLUMN ssh_user TEXT;
      ALTER TABLE projects ADD COLUMN ssh_port INTEGER;
      ALTER TABLE projects ADD COLUMN ssh_key  TEXT;
    `)
  }

  const selectSetting = db.prepare(`SELECT value FROM settings WHERE key = ?`)
  const upsertSetting = db.prepare(`
    INSERT INTO settings (key, value) VALUES (@key, @value)
    ON CONFLICT(key) DO UPDATE SET value = @value
  `)
  const selectAllSettings = db.prepare(`SELECT key, value FROM settings ORDER BY key ASC`)

  const insertProject = db.prepare(`
    INSERT INTO projects (id, name, cwd, created_at, ssh_host, ssh_user, ssh_port, ssh_key)
    VALUES (@id, @name, @cwd, @createdAt, @sshHost, @sshUser, @sshPort, @sshKey)
  `)
  const selectProject = db.prepare(`SELECT * FROM projects WHERE id = ?`)
  const selectAllProjects = db.prepare(`SELECT * FROM projects ORDER BY created_at ASC`)
  const deleteProjectStmt = db.prepare(`DELETE FROM projects WHERE id = ?`)

  const insertArchive = db.prepare(`
    INSERT OR IGNORE INTO archived_sessions (project_id, session_id, archived_at)
    VALUES (@projectId, @sessionId, @archivedAt)
  `)
  const deleteArchive = db.prepare(`
    DELETE FROM archived_sessions WHERE project_id = @projectId AND session_id = @sessionId
  `)
  const selectArchives = db.prepare(`
    SELECT session_id FROM archived_sessions WHERE project_id = ? ORDER BY archived_at DESC
  `)

  const insertManaged = db.prepare(`
    INSERT OR IGNORE INTO managed_sessions (project_id, session_id)
    VALUES (@projectId, @sessionId)
  `)
  const selectManaged = db.prepare(`
    SELECT session_id FROM managed_sessions WHERE project_id = ? ORDER BY session_id ASC
  `)

  /** Architecture: docs/architecture.md#settings */
  function getSetting(key) {
    const row = selectSetting.get(key)
    return row ? row.value : null
  }

  /** Architecture: docs/architecture.md#settings */
  function setSetting(key, value) {
    upsertSetting.run({ key, value })
  }

  /** Architecture: docs/architecture.md#settings */
  function getAllSettings() {
    const result = {}
    for (const row of selectAllSettings.all()) result[row.key] = row.value
    return result
  }

  /** Architecture: docs/architecture.md#projects */
  function createProject(name, cwd, existingId = null, ssh = {}) {
    const id = existingId || ulid()
    insertProject.run({
      id,
      name,
      cwd,
      createdAt: Date.now(),
      sshHost: ssh.host || null,
      sshUser: ssh.user || null,
      sshPort: ssh.port || null,
      sshKey: ssh.key || null,
    })
    return selectProject.get(id)
  }

  /** Architecture: docs/architecture.md#projects */
  function getProject(id) {
    return selectProject.get(id)
  }

  /** Architecture: docs/architecture.md#projects */
  function listProjects() {
    return selectAllProjects.all()
  }

  /** Architecture: docs/architecture.md#projects */
  function removeProject(id) {
    deleteProjectStmt.run(id)
  }

  /** Architecture: docs/architecture.md#projects */
  function migrateProjectsJson(jsonPath) {
    if (!existsSync(jsonPath)) return
    try {
      const projects = JSON.parse(readFileSync(jsonPath, 'utf-8'))
      const existing = selectAllProjects.all()
      const existingIds = new Set(existing.map((project) => project.id))
      const existingCwds = new Set(existing.map((project) => project.cwd))
      for (const project of projects) {
        if (!existingIds.has(project.id) && !existingCwds.has(project.cwd)) {
          insertProject.run({
            id: project.id,
            name: project.name,
            cwd: project.cwd,
            createdAt: Date.now(),
          })
        }
      }
      renameSync(jsonPath, `${jsonPath}.bak`)
    } catch {
      /* ignore migration errors */
    }
  }

  /** Architecture: docs/architecture.md#projects */
  function ensureStarterProject() {
    if (selectAllProjects.all().length > 0) return
    const cwd = process.cwd()
    const name = cwd.split('/').filter(Boolean).pop() || 'project'
    createProject(name, cwd)
  }

  /** Architecture: docs/architecture.md#session-metadata */
  function archiveSession(projectId, sessionId) {
    insertArchive.run({ projectId, sessionId, archivedAt: Date.now() })
  }

  /** Architecture: docs/architecture.md#session-metadata */
  function unarchiveSession(projectId, sessionId) {
    deleteArchive.run({ projectId, sessionId })
  }

  /** Architecture: docs/architecture.md#session-metadata */
  function listArchivedSessions(projectId) {
    return selectArchives.all(projectId).map((row) => row.session_id)
  }

  /** Architecture: docs/architecture.md#session-metadata */
  function markSessionManaged(projectId, sessionId) {
    insertManaged.run({ projectId, sessionId })
  }

  /** Architecture: docs/architecture.md#session-metadata */
  function listManagedSessions(projectId) {
    return selectManaged.all(projectId).map((row) => row.session_id)
  }

  function close() {
    db.close()
  }

  return {
    getSetting,
    setSetting,
    getAllSettings,
    createProject,
    getProject,
    listProjects,
    removeProject,
    migrateProjectsJson,
    ensureStarterProject,
    archiveSession,
    unarchiveSession,
    listArchivedSessions,
    markSessionManaged,
    listManagedSessions,
    close,
  }
}

let _instance = null

/** Architecture: docs/architecture.md#server-architecture */
export function getStore(dbPath = 'data/nanocode.db') {
  if (!_instance) {
    const dir = dbPath.substring(0, dbPath.lastIndexOf('/'))
    if (dir) mkdirSync(dir, { recursive: true })
    _instance = createStore(dbPath)
  }
  return _instance
}
