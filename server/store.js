/**
 * SQLite data layer for tasks, task events, and projects.
 *
 * Factory function createStore(dbPath) returns the store API.
 * Uses WAL mode, foreign keys, and prepared statements.
 */

import Database from 'better-sqlite3'
import { mkdirSync, existsSync, readFileSync, renameSync } from 'fs'
import { ulid } from 'ulid'

const TASK_UPDATE_FIELDS = new Set([
  'status',
  'plan_result',
  'feedback',
  'turns',
  'cost_usd',
  'started_at',
  'ended_at',
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
  `)

  // Migration: add project_id to existing tasks table
  try {
    db.exec(`ALTER TABLE tasks ADD COLUMN project_id TEXT REFERENCES projects(id)`)
  } catch {
    // Column already exists
  }

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

  const insertEvent = db.prepare(`
    INSERT INTO task_events (task_id, kind, data, created_at)
    VALUES (@taskId, @kind, @data, @createdAt)
  `)
  const selectEvents = db.prepare(
    `SELECT * FROM task_events WHERE task_id = ? AND id > ? ORDER BY id ASC`
  )
  const selectEvent = db.prepare(`SELECT * FROM task_events WHERE id = ?`)

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

  function close() {
    db.close()
  }

  return {
    createProject, getProject, listProjects, removeProject,
    migrateProjectsJson, ensureStarterProject,
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
