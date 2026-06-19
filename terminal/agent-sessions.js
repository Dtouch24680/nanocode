/**
 * Agent sessions service — aggregates resumable sessions across all agent
 * types (claude, codex, opencode) for a given project cwd.
 *
 * Each scanner returns entries in a uniform shape:
 *   { type, sessionId, summary, mtime, relTime, active, hasTab, tabId }
 *
 * Cursor agent has no persistent session store and is omitted.
 */

import { existsSync, readdirSync, readFileSync, statSync, openSync, readSync, closeSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { loadOpenCodeSessionExport } from './opencode-history.js'
import { cwdToClaudeProjectDir } from './claude-history.js'
import { extractSummary, relTimeFromMtime } from './recent-agents.js'

const ACTIVE_WINDOW_MS = 5 * 60 * 1000

/**
 * Scan claude sessions for a project cwd.
 * Reads ~/.claude/projects/<encoded-cwd>/*.jsonl.
 */
function scanClaudeSessions(home, cwd, tabs) {
  const projectDir = cwdToClaudeProjectDir(home, cwd)
  if (!existsSync(projectDir)) return []
  const tabBySession = new Map()
  for (const tab of tabs) {
    if (tab.type === 'claude' && tab.claudeSessionId) tabBySession.set(tab.claudeSessionId, tab.id)
  }
  let files
  try { files = readdirSync(projectDir) } catch { return [] }
  const now = Date.now()
  const entries = []
  for (const f of files) {
    if (!f.endsWith('.jsonl')) continue
    const fullPath = join(projectDir, f)
    let mtimeMs
    try { mtimeMs = statSync(fullPath).mtimeMs } catch { continue }
    const sessionId = f.replace(/\.jsonl$/, '')
    entries.push({
      type: 'claude',
      sessionId,
      summary: extractSummary(fullPath),
      mtime: new Date(mtimeMs).toISOString(),
      relTime: relTimeFromMtime(mtimeMs, now),
      active: now - mtimeMs <= ACTIVE_WINDOW_MS,
      hasTab: tabBySession.has(sessionId),
      tabId: tabBySession.get(sessionId) || null,
      _mtimeMs: mtimeMs,
    })
  }
  return entries
}

/**
 * Scan codex sessions for a project cwd.
 * Walks ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl, filters by cwd in session_meta.
 */
function scanCodexSessions(home, cwd, tabs) {
  const root = join(home, '.codex', 'sessions')
  if (!existsSync(root)) return []
  const tabByThread = new Map()
  for (const tab of tabs) {
    if (tab.type === 'codex' && tab.codexThreadId) tabByThread.set(tab.codexThreadId, tab.id)
  }
  const now = Date.now()
  const entries = []

  function walk(dir) {
    let items
    try { items = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of items) {
      if (entry.isDirectory()) {
        walk(join(dir, entry.name))
      } else if (entry.isFile() && entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl')) {
        const fullPath = join(dir, entry.name)
        let mtimeMs
        try { mtimeMs = statSync(fullPath).mtimeMs } catch { continue }
        // Read the first few lines to extract session_meta (threadId + cwd)
        // and the first user message for the summary.
        const { threadId, sessionCwd, summary } = readCodexMeta(fullPath)
        if (!threadId) continue
        // Only include sessions whose cwd matches this project
        if (sessionCwd && sessionCwd !== cwd) continue
        entries.push({
          type: 'codex',
          sessionId: threadId,
          summary: summary || '(无摘要)',
          mtime: new Date(mtimeMs).toISOString(),
          relTime: relTimeFromMtime(mtimeMs, now),
          active: now - mtimeMs <= ACTIVE_WINDOW_MS,
          hasTab: tabByThread.has(threadId),
          tabId: tabByThread.get(threadId) || null,
          _mtimeMs: mtimeMs,
        })
      }
    }
  }
  walk(root)
  return entries
}

/** Read codex rollout file header for threadId, cwd, and first user message. */
function readCodexMeta(path) {
  const MAX_BYTES = 32768
  let fd
  try {
    fd = openSync(path, 'r')
    const buf = Buffer.allocUnsafe(MAX_BYTES)
    let bytesRead = 0
    try { bytesRead = readSync(fd, buf, 0, MAX_BYTES, 0) } finally { closeSync(fd) }
    const chunk = buf.slice(0, bytesRead).toString('utf-8')
    const lines = chunk.split('\n')
    let threadId = null
    let sessionCwd = null
    let summary = null
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      let row
      try { row = JSON.parse(trimmed) } catch { continue }
      if (row.type === 'session_meta' && row.payload) {
        threadId = row.payload.id || threadId
        sessionCwd = row.payload.cwd || sessionCwd
      }
      if (row.type === 'event_msg' && row.payload?.type === 'user_message' && row.payload.message) {
        // Skip injected context messages
        const msg = row.payload.message
        if (msg.startsWith('<environment_context>') || msg.startsWith('<permissions') || msg.startsWith('<user_instructions>')) continue
        summary = msg.trim().slice(0, 120)
        break
      }
    }
    return { threadId, sessionCwd, summary }
  } catch {
    return { threadId: null, sessionCwd: null, summary: null }
  }
}

/**
 * Scan opencode sessions for a project cwd.
 * Queries the opencode SQLite DB at ~/.local/share/opencode/opencode.db.
 */
function scanOpenCodeSessions(home, cwd, tabs) {
  const dbPath = join(home, '.local', 'share', 'opencode', 'opencode.db')
  if (!existsSync(dbPath)) return []
  const tabBySession = new Map()
  for (const tab of tabs) {
    if (tab.type === 'opencode' && tab.opencodeSessionId) tabBySession.set(tab.opencodeSessionId, tab.id)
  }
  const now = Date.now()
  let db
  try {
    db = new DatabaseSync(dbPath, { readOnly: true })
  } catch {
    return []
  }
  try {
    // Match by directory field (opencode stores the cwd the session ran in).
    const rows = db.prepare(
      `SELECT id, title, directory, time_updated FROM session
       WHERE directory = ? AND time_archived IS NULL
       ORDER BY time_updated DESC LIMIT 50`
    ).all(cwd)
    return rows.map((row) => {
      const mtimeMs = row.time_updated || 0
      return {
        type: 'opencode',
        sessionId: row.id,
        summary: row.title || '(无摘要)',
        mtime: new Date(mtimeMs).toISOString(),
        relTime: relTimeFromMtime(mtimeMs, now),
        active: now - mtimeMs <= ACTIVE_WINDOW_MS,
        hasTab: tabBySession.has(row.id),
        tabId: tabBySession.get(row.id) || null,
        _mtimeMs: mtimeMs,
      }
    })
  } catch {
    return []
  } finally {
    try { db.close() } catch {}
  }
}

/**
 * Aggregate all agent sessions for a project, sorted by mtime descending.
 * @returns {Promise<Array>} entries without the internal _mtimeMs field
 */
export async function listAgentSessions(home, cwd, tabs) {
  const all = [
    ...scanClaudeSessions(home, cwd, tabs),
    ...scanCodexSessions(home, cwd, tabs),
    ...scanOpenCodeSessions(home, cwd, tabs),
  ]
  all.sort((a, b) => b._mtimeMs - a._mtimeMs)
  return all.map(({ _mtimeMs, ...rest }) => rest)
}
