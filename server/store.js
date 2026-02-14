/**
 * SQLite data layer for tasks and task events.
 *
 * Factory function createStore(dbPath) returns the store API.
 * Uses WAL mode, foreign keys, and prepared statements.
 *
 * Architecture: server/docs/task-lifecycle.md#storage
 */

import Database from 'better-sqlite3'
import { mkdirSync } from 'fs'
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
 *
 * @param {string} dbPath — file path or ':memory:' for testing
 * @returns {object} Store API
 *
 * Architecture: server/docs/task-lifecycle.md#storage
 */
export function createStore(dbPath = ':memory:') {
  const db = new Database(dbPath)

  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')

  db.exec(`
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

  // Auto-incrementing sequence for display ordering
  const seqStmt = db.prepare(
    `SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM tasks`
  )

  const insertTask = db.prepare(`
    INSERT INTO tasks (id, seq, title, type, cwd, depends_on, created_at)
    VALUES (@id, @seq, @title, @type, @cwd, @dependsOn, @createdAt)
  `)

  const selectTask = db.prepare(`SELECT * FROM tasks WHERE id = ?`)

  const selectAllTasks = db.prepare(
    `SELECT * FROM tasks ORDER BY seq ASC`
  )

  const insertEvent = db.prepare(`
    INSERT INTO task_events (task_id, kind, data, created_at)
    VALUES (@taskId, @kind, @data, @createdAt)
  `)

  const selectEvents = db.prepare(
    `SELECT * FROM task_events WHERE task_id = ? AND id > ? ORDER BY id ASC`
  )

  const selectEvent = db.prepare(
    `SELECT * FROM task_events WHERE id = ?`
  )

  /**
   * Create a new task.
   *
   * @param {{ title: string, type?: string, cwd: string, dependsOn?: string }} params
   * @returns {object} The created task row
   *
   * Architecture: docs/architecture.md#rest-task-crud
   */
  function createTask({ title, type = 'task', cwd, dependsOn = null }) {
    const id = ulid()
    const { next } = seqStmt.get()
    insertTask.run({
      id,
      seq: next,
      title,
      type,
      cwd,
      dependsOn,
      createdAt: Date.now(),
    })
    return selectTask.get(id)
  }

  /**
   * Get a single task by ID.
   *
   * @param {string} id
   * @returns {object|undefined}
   */
  function getTask(id) {
    return selectTask.get(id)
  }

  /**
   * List all tasks ordered by seq.
   *
   * @returns {object[]}
   */
  function listTasks() {
    return selectAllTasks.all()
  }

  /**
   * Update allowed fields on a task.
   *
   * Only fields in TASK_UPDATE_FIELDS are permitted.
   * Throws on unknown field names to prevent SQL injection.
   *
   * @param {string} id
   * @param {object} fields
   * @returns {object} The updated task row
   *
   * Architecture: docs/architecture.md#rest-task-crud
   */
  function updateTask(id, fields) {
    const keys = Object.keys(fields)
    if (keys.length === 0) return getTask(id)

    for (const key of keys) {
      if (!TASK_UPDATE_FIELDS.has(key)) {
        throw new Error(`updateTask: unknown field "${key}"`)
      }
    }

    const setClauses = keys.map((k) => `${k} = @${k}`).join(', ')
    const stmt = db.prepare(
      `UPDATE tasks SET ${setClauses} WHERE id = @id`
    )
    stmt.run({ id, ...fields })
    return selectTask.get(id)
  }

  /**
   * Append an event to the task event log.
   *
   * @param {string} taskId
   * @param {string} kind — 'text' | 'tool_use' | 'tool_result' | 'error' | 'approval_req'
   * @param {object} data — arbitrary JSON-serializable data
   * @returns {object} The created event row with data parsed back to object
   *
   * Architecture: server/docs/worker-streaming.md#event-append
   */
  function appendEvent(taskId, kind, data) {
    const result = insertEvent.run({
      taskId,
      kind,
      data: JSON.stringify(data),
      createdAt: Date.now(),
    })
    const row = selectEvent.get(result.lastInsertRowid)
    return { ...row, data: JSON.parse(row.data) }
  }

  /**
   * Get events for a task, optionally after a given event ID (for incremental fetch).
   *
   * @param {string} taskId
   * @param {number} [afterId=0]
   * @returns {object[]} Events with data parsed to objects
   *
   * Architecture: server/docs/worker-streaming.md#incremental-fetch
   */
  function getEvents(taskId, afterId = 0) {
    const rows = selectEvents.all(taskId, afterId)
    return rows.map((r) => ({ ...r, data: JSON.parse(r.data) }))
  }

  /**
   * Close the database connection.
   */
  function close() {
    db.close()
  }

  return {
    createTask,
    getTask,
    listTasks,
    updateTask,
    appendEvent,
    getEvents,
    close,
  }
}

/** Lazy singleton for the server process. */
let _instance = null

/**
 * Get or create the default store instance.
 *
 * @param {string} [dbPath='data/codebuilder.db']
 * @returns {object} Store API
 */
export function getStore(dbPath = 'data/codebuilder.db') {
  if (!_instance) {
    const dir = dbPath.substring(0, dbPath.lastIndexOf('/'))
    if (dir) mkdirSync(dir, { recursive: true })
    _instance = createStore(dbPath)
  }
  return _instance
}
