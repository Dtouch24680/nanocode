/**
 * SQLite data layer for tasks, task events, and projects.
 *
 * Factory function createStore(dbPath) returns the store API.
 * Uses WAL mode, foreign keys, and prepared statements.
 */

import Database from 'better-sqlite3'
import { mkdirSync, existsSync, readFileSync, readdirSync, renameSync, statSync, openSync, readSync, closeSync } from 'fs'
import { join, basename } from 'path'
import { homedir } from 'os'
import { ulid } from 'ulid'

const TASK_UPDATE_FIELDS = new Set([
  'status',
  'plan_result',
  'feedback',
  'turns',
  'cost_usd',
  'started_at',
  'ended_at',
  'session_id',
  'resume_session_id',
])

/**
 * Create a store instance backed by the given SQLite database path.
 */
export function createStore(dbPath = ':memory:') {
  const db = new Database(dbPath)

  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')

  // --- Schema ---

  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      cwd        TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id          TEXT PRIMARY KEY,
      seq         INTEGER,
      title       TEXT NOT NULL,
      type        TEXT NOT NULL DEFAULT 'task',
      status      TEXT NOT NULL DEFAULT 'pending',
      cwd         TEXT NOT NULL,
      depends_on  TEXT REFERENCES tasks(id),
      plan_result TEXT,
      feedback    TEXT,
      turns       INTEGER NOT NULL DEFAULT 0,
      cost_usd    REAL NOT NULL DEFAULT 0,
      created_at  INTEGER NOT NULL,
      started_at  INTEGER,
      ended_at    INTEGER
    );

    CREATE TABLE IF NOT EXISTS task_events (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id     TEXT NOT NULL REFERENCES tasks(id),
      kind        TEXT NOT NULL,
      data        TEXT NOT NULL,
      created_at  INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_events_task ON task_events(task_id, id);

    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS archived_sessions (
      project_id  TEXT NOT NULL,
      session_id  TEXT NOT NULL,
      archived_at INTEGER NOT NULL,
      PRIMARY KEY (project_id, session_id)
    );

    CREATE TABLE IF NOT EXISTS managed_sessions (
      project_id  TEXT NOT NULL,
      session_id  TEXT NOT NULL,
      PRIMARY KEY (project_id, session_id)
    );
  `)

  // Migration: add project_id to existing tasks table
  try {
    db.exec(`ALTER TABLE tasks ADD COLUMN project_id TEXT REFERENCES projects(id)`)
  } catch {
    // Column already exists
  }

  // Migration: add session_id to track imported Claude sessions
  try {
    db.exec(`ALTER TABLE tasks ADD COLUMN session_id TEXT`)
  } catch {
    // Column already exists
  }
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_session_id ON tasks(session_id) WHERE session_id IS NOT NULL`)

  // Migration: add resume_session_id for continuation tasks
  try {
    db.exec(`ALTER TABLE tasks ADD COLUMN resume_session_id TEXT`)
  } catch {
    // Column already exists
  }

  // --- Settings statements ---

  const selectSetting = db.prepare(`SELECT value FROM settings WHERE key = ?`)
  const upsertSetting = db.prepare(`
    INSERT INTO settings (key, value) VALUES (@key, @value)
    ON CONFLICT(key) DO UPDATE SET value = @value
  `)
  const selectAllSettings = db.prepare(`SELECT key, value FROM settings`)

  // --- Project statements ---

  const insertProject = db.prepare(`
    INSERT INTO projects (id, name, cwd, created_at)
    VALUES (@id, @name, @cwd, @createdAt)
  `)
  const selectProject = db.prepare(`SELECT * FROM projects WHERE id = ?`)
  const selectAllProjects = db.prepare(`SELECT * FROM projects ORDER BY created_at ASC`)
  const deleteProjectStmt = db.prepare(`DELETE FROM projects WHERE id = ?`)

  // --- Task statements ---

  const seqStmt = db.prepare(`SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM tasks`)

  const insertTask = db.prepare(`
    INSERT INTO tasks (id, seq, title, type, cwd, project_id, depends_on, created_at)
    VALUES (@id, @seq, @title, @type, @cwd, @projectId, @dependsOn, @createdAt)
  `)
  const selectTask = db.prepare(`SELECT * FROM tasks WHERE id = ?`)
  const selectAllTasks = db.prepare(`SELECT * FROM tasks ORDER BY seq ASC`)
  const selectTasksByProject = db.prepare(`SELECT * FROM tasks WHERE project_id = ? ORDER BY seq ASC`)
  const selectTaskBySessionId = db.prepare(`SELECT id FROM tasks WHERE session_id = ?`)

  const insertImportedTask = db.prepare(`
    INSERT INTO tasks (id, seq, title, type, status, cwd, project_id, session_id, turns, cost_usd, created_at, started_at, ended_at)
    VALUES (@id, @seq, @title, @type, @status, @cwd, @projectId, @sessionId, 0, 0, @createdAt, @startedAt, @endedAt)
  `)

  const insertEvent = db.prepare(`
    INSERT INTO task_events (task_id, kind, data, created_at)
    VALUES (@taskId, @kind, @data, @createdAt)
  `)
  const selectEvents = db.prepare(
    `SELECT * FROM task_events WHERE task_id = ? AND id > ? ORDER BY id ASC`
  )
  const selectEvent = db.prepare(`SELECT * FROM task_events WHERE id = ?`)

  // --- Archived sessions statements ---

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
  const selectArchiveOne = db.prepare(`
    SELECT 1 FROM archived_sessions WHERE project_id = @projectId AND session_id = @sessionId
  `)

  // ==================== Archived Sessions CRUD ====================

  function archiveSession(projectId, sessionId) {
    insertArchive.run({ projectId, sessionId, archivedAt: Date.now() })
  }

  function unarchiveSession(projectId, sessionId) {
    deleteArchive.run({ projectId, sessionId })
  }

  function listArchivedSessions(projectId) {
    return selectArchives.all(projectId).map(r => r.session_id)
  }

  function isSessionArchived(projectId, sessionId) {
    return !!selectArchiveOne.get({ projectId, sessionId })
  }

  // --- Managed sessions statements ---

  const insertManaged = db.prepare(`
    INSERT OR IGNORE INTO managed_sessions (project_id, session_id)
    VALUES (@projectId, @sessionId)
  `)
  const selectManaged = db.prepare(`
    SELECT session_id FROM managed_sessions WHERE project_id = ?
  `)

  // ==================== Managed Sessions CRUD ====================

  function markSessionManaged(projectId, sessionId) {
    insertManaged.run({ projectId, sessionId })
  }

  function listManagedSessions(projectId) {
    return selectManaged.all(projectId).map(r => r.session_id)
  }

  // ==================== Settings CRUD ====================

  function getSetting(key) {
    const row = selectSetting.get(key)
    return row ? row.value : null
  }

  function setSetting(key, value) {
    upsertSetting.run({ key, value })
  }

  function getAllSettings() {
    const rows = selectAllSettings.all()
    const result = {}
    for (const row of rows) result[row.key] = row.value
    return result
  }

  // ==================== Project CRUD ====================

  function createProject(name, cwd, existingId = null) {
    const id = existingId || ulid()
    insertProject.run({ id, name, cwd, createdAt: Date.now() })
    return selectProject.get(id)
  }

  function getProject(id) {
    return selectProject.get(id)
  }

  function listProjects() {
    return selectAllProjects.all()
  }

  function removeProject(id) {
    deleteProjectStmt.run(id)
  }

  /**
   * Migrate projects from terminal/projects.json into SQLite.
   * Renames the file to .bak after migration.
   * Idempotent: skips projects whose id or cwd already exists.
   */
  function migrateProjectsJson(jsonPath) {
    if (!existsSync(jsonPath)) return
    try {
      const projects = JSON.parse(readFileSync(jsonPath, 'utf-8'))
      const existing = selectAllProjects.all()
      const existingIds = new Set(existing.map(p => p.id))
      const existingCwds = new Set(existing.map(p => p.cwd))
      for (const p of projects) {
        if (!existingIds.has(p.id) && !existingCwds.has(p.cwd)) {
          insertProject.run({ id: p.id, name: p.name, cwd: p.cwd, createdAt: Date.now() })
        }
      }
      renameSync(jsonPath, jsonPath + '.bak')
    } catch { /* ignore migration errors */ }
  }

  /** Ensure at least one project exists (starter from cwd). */
  function ensureStarterProject() {
    if (selectAllProjects.all().length > 0) return
    const cwd = process.cwd()
    const name = cwd.split('/').filter(Boolean).pop() || 'project'
    createProject(name, cwd)
  }

  // ==================== Task CRUD ====================

  function createTask({ title, type = 'task', cwd, projectId = null, dependsOn = null }) {
    if (!cwd && projectId) {
      const project = getProject(projectId)
      if (project) cwd = project.cwd
    }
    if (!cwd) throw new Error('cwd is required (provide cwd or valid projectId)')

    const id = ulid()
    const { next } = seqStmt.get()
    insertTask.run({
      id, seq: next, title, type, cwd,
      projectId: projectId || null,
      dependsOn,
      createdAt: Date.now(),
    })
    return selectTask.get(id)
  }

  function getTask(id) {
    return selectTask.get(id)
  }

  function listTasks() {
    return selectAllTasks.all()
  }

  function listTasksByProject(projectId) {
    return selectTasksByProject.all(projectId)
  }

  function updateTask(id, fields) {
    const keys = Object.keys(fields)
    if (keys.length === 0) return getTask(id)
    for (const key of keys) {
      if (!TASK_UPDATE_FIELDS.has(key)) throw new Error(`updateTask: unknown field "${key}"`)
    }
    const setClauses = keys.map((k) => `${k} = @${k}`).join(', ')
    db.prepare(`UPDATE tasks SET ${setClauses} WHERE id = @id`).run({ id, ...fields })
    return selectTask.get(id)
  }

  function appendEvent(taskId, kind, data) {
    const result = insertEvent.run({
      taskId, kind, data: JSON.stringify(data), createdAt: Date.now(),
    })
    const row = selectEvent.get(result.lastInsertRowid)
    return { ...row, data: JSON.parse(row.data) }
  }

  function getEvents(taskId, afterId = 0) {
    const rows = selectEvents.all(taskId, afterId)
    return rows.map((r) => ({ ...r, data: JSON.parse(r.data) }))
  }

  /**
   * Import existing Claude Code sessions as done tasks.
   * Reads ~/.claude/history.jsonl for display text and timestamps,
   * then scans each project's encoded session directory for .jsonl files.
   * Idempotent via unique session_id index.
   */
  function importClaudeSessions() {
    const claudeDir = join(homedir(), '.claude')
    const projectsDir = join(claudeDir, 'projects')
    if (!existsSync(projectsDir)) return

    // Build history map: sessionId -> { display, timestamp, project }
    const historyMap = new Map()
    const historyPath = join(claudeDir, 'history.jsonl')
    if (existsSync(historyPath)) {
      try {
        const lines = readFileSync(historyPath, 'utf-8').split('\n')
        for (const line of lines) {
          if (!line.trim()) continue
          try {
            const entry = JSON.parse(line)
            const sid = entry.sessionId
            if (!sid) continue
            // Keep first entry per session (earliest display text)
            if (!historyMap.has(sid)) {
              historyMap.set(sid, {
                display: entry.display || '',
                timestamp: entry.timestamp || 0,
                project: entry.project || '',
              })
            }
          } catch { /* skip malformed lines */ }
        }
      } catch { /* history file unreadable */ }
    }

    const projects = selectAllProjects.all()
    let imported = 0

    for (const project of projects) {
      // Encode cwd to match Claude's folder naming: /foo/bar -> -foo-bar
      const encoded = project.cwd.replace(/\//g, '-')
      const sessionDir = join(projectsDir, encoded)
      if (!existsSync(sessionDir)) continue

      let files
      try { files = readdirSync(sessionDir).filter(f => f.endsWith('.jsonl')) } catch { continue }

      for (const file of files) {
        const sessionId = basename(file, '.jsonl')

        // Skip if already imported
        if (selectTaskBySessionId.get(sessionId)) continue

        const filePath = join(sessionDir, file)

        // Read first 32KB to find first timestamp and check for real user messages
        let chunk
        try {
          const fd = openSync(filePath, 'r')
          const buf = Buffer.alloc(32768)
          const bytesRead = readSync(fd, buf, 0, 32768, 0)
          closeSync(fd)
          chunk = buf.toString('utf-8', 0, bytesRead)
        } catch { continue }

        let firstTimestamp = null
        let hasRealUser = false

        for (const line of chunk.split('\n')) {
          if (!line.trim()) continue
          try {
            const obj = JSON.parse(line)
            // Grab first timestamp we see
            if (!firstTimestamp && obj.timestamp) {
              firstTimestamp = typeof obj.timestamp === 'string'
                ? new Date(obj.timestamp).getTime()
                : obj.timestamp
            }
            // Check for real (non-meta, non-command) user messages
            if (obj.type === 'user' && !obj.isMeta) {
              const content = obj.message?.content || ''
              if (!content.startsWith('<command-name>') && !content.startsWith('<local-command')) {
                hasRealUser = true
              }
            }
          } catch { /* skip malformed */ }
        }

        // Skip sessions without real user interaction
        if (!hasRealUser) continue

        // Determine title from history.jsonl display text, fallback to sessionId
        const histEntry = historyMap.get(sessionId)
        let title = histEntry?.display || sessionId
        // Clean up slash-command prefixes (e.g. "/add-dir ...")
        if (title.startsWith('/') && title.length > 40) {
          title = title.substring(0, 40) + '...'
        }

        // Determine timestamps
        const createdAt = firstTimestamp || Date.now()
        let endedAt = createdAt
        // Use file mtime as ended_at (more accurate than parsing entire large file)
        try {
          const stat = statSync(filePath)
          endedAt = stat.mtimeMs
        } catch { /* use createdAt */ }
        // If history has a later timestamp for this session, prefer it
        if (histEntry?.timestamp && histEntry.timestamp > endedAt) {
          endedAt = histEntry.timestamp
        }

        const id = ulid()
        const { next } = seqStmt.get()
        insertImportedTask.run({
          id, seq: next, title, type: 'task', status: 'done',
          cwd: project.cwd, projectId: project.id, sessionId,
          createdAt, startedAt: createdAt, endedAt,
        })
        imported++
      }
    }

    if (imported > 0) {
      console.log(`Imported ${imported} Claude Code session(s) as done tasks`)
    }
  }

  function close() {
    db.close()
  }

  return {
    getSetting, setSetting, getAllSettings,
    createProject, getProject, listProjects, removeProject,
    migrateProjectsJson, ensureStarterProject, importClaudeSessions,
    archiveSession, unarchiveSession, listArchivedSessions, isSessionArchived,
    markSessionManaged, listManagedSessions,
    createTask, getTask, listTasks, listTasksByProject, updateTask,
    appendEvent, getEvents, close,
  }
}

/** Lazy singleton for the server process. */
let _instance = null

export function getStore(dbPath = 'data/codebuilder.db') {
  if (!_instance) {
    const dir = dbPath.substring(0, dbPath.lastIndexOf('/'))
    if (dir) mkdirSync(dir, { recursive: true })
    _instance = createStore(dbPath)
  }
  return _instance
}
