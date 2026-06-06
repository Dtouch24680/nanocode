import { createHash, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

export function cwdToClaudeProjectDir(home, cwd) {
  const encoded = cwd.replace(/\//g, '-')
  return join(home, '.claude', 'projects', encoded)
}

function hashReplayText(text) {
  return createHash('sha1').update(text).digest('hex').slice(0, 16)
}

export function extractReplayUserText(message) {
  const content = message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((part) => part?.type === 'text')
    .map((part) => part.text ?? '')
    .join('')
}

export function buildUserReplayId(text, userTextCounts) {
  if (!text) return null
  const next = (userTextCounts.get(text) ?? 0) + 1
  userTextCounts.set(text, next)
  return `user:${hashReplayText(text)}:${next}`
}

function buildAssistantReplayId(row) {
  if (row.uuid) return row.uuid
  if (!row.requestId) return null
  const firstType = row.message?.content?.[0]?.type || 'unknown'
  return `assistant:${row.requestId}:${firstType}`
}

export function buildReplaySeed(events) {
  const userTextCounts = new Map()
  for (const event of events) {
    if (event.type !== 'user') continue
    const text = extractReplayUserText(event.message)
    if (!text) continue
    userTextCounts.set(text, (userTextCounts.get(text) ?? 0) + 1)
  }
  // hasHistory=true signals to attachClaudeSession that this tab is restoring
  // an existing conversation — the first user turn should use --resume (not --session-id).
  const hasHistory = events.length > 0
  return { userTextCounts, hasHistory }
}

/**
 * Parse a jsonl session file into renderer-compatible events.
 * Returns an array of {type, message, uuid, parent_tool_use_id} objects.
 *
 * Strategy for multiple assistant rows per turn:
 * Claude CLI streams assistant messages incrementally and writes each delta
 * as a new jsonl row. The final row for a given requestId has the complete
 * content. We collect all assistant rows, then for each requestId keep only
 * the last (most complete) one. This avoids rendering duplicate/partial text.
 */
export function parseJsonlHistory(jsonlPath) {
  let content
  try {
    content = readFileSync(jsonlPath, 'utf-8')
  } catch {
    return []
  }

  const lines = content.split('\n').filter((l) => l.trim())
  const events = []
  const replayState = { userTextCounts: new Map() }

  const rawRows = []
  for (const line of lines) {
    let row
    try { row = JSON.parse(line) } catch { continue }
    rawRows.push(row)
  }

  // N52 fix: de-duplicate assistant rows correctly for Claude CLI stream-json format.
  //
  // BACKGROUND: Claude CLI emits MULTIPLE separate assistant rows per turn (one per
  // content block: thinking -> text -> tool_use -> text). All rows within the same turn
  // share the SAME requestId. The old logic kept only the LAST row per requestId
  // (treating it like a progressive streaming case where later rows supersede earlier
  // ones). But in practice, each row carries a DISTINCT content block type - keeping
  // only the last drops intermediate content (e.g. the leading "Hello!" text block
  // before a tool_use, causing N52: text1 visible during live streaming but missing
  // on history replay).
  //
  // NEW STRATEGY: for rows with the same requestId, group them and deduplicate WITHIN
  // each content-type. If two rows share both requestId AND content block type, keep
  // only the last (that is the true progressive-streaming case - partial -> complete
  // for the same block). If they have different content types, keep both in order.
  //
  // Dedup key: requestId + first-content-block-type (e.g. 'req_xxx:text', 'req_xxx:tool_use').
  // Rows without requestId are never deduplicated (kept as-is).
  //
  // Example for a turn with requestId='req_abc':
  //   row1: {requestId:'req_abc', content:[{type:'thinking'}]}  -> key 'req_abc:thinking'
  //   row2: {requestId:'req_abc', content:[{type:'text', text:'Hi!'}]}  -> key 'req_abc:text'
  //   row3: {requestId:'req_abc', content:[{type:'tool_use'}]}  -> key 'req_abc:tool_use'
  //   -> all THREE are kept (different content types)
  //
  // Example for progressive streaming (partial -> complete same block):
  //   row1: {requestId:'req_abc', content:[{type:'text', text:'Hi'}]}  -> key 'req_abc:text'
  //   row2: {requestId:'req_abc', content:[{type:'text', text:'Hi!'}]}  -> key 'req_abc:text'
  //   -> only row2 kept (same key, later row wins)
  const assistantByKey = new Map()
  for (const row of rawRows) {
    if (row.type !== 'assistant') continue
    const rid = row.requestId
    if (!rid) continue
    const msg = row.message
    if (!msg || !Array.isArray(msg.content) || msg.content.length === 0) continue
    const firstType = msg.content[0]?.type || 'unknown'
    const key = `${rid}:${firstType}`
    assistantByKey.set(key, row)
  }

  const emittedKeys = new Set()
  for (const row of rawRows) {
    if (row.type === 'user') {
      const msg = row.message
      if (!msg || !msg.content) continue
      events.push({
        type: 'user',
        message: msg,
        uuid: row.uuid || null,
        replay_id: buildUserReplayId(extractReplayUserText(msg), replayState.userTextCounts),
        parent_tool_use_id: row.parent_tool_use_id || null,
      })
    } else if (row.type === 'assistant') {
      const msg = row.message
      if (!msg || !Array.isArray(msg.content)) continue
      const rid = row.requestId
      if (rid) {
        const firstType = msg.content[0]?.type || 'unknown'
        const key = `${rid}:${firstType}`
        if (assistantByKey.get(key) !== row) continue
        if (emittedKeys.has(key)) continue
        emittedKeys.add(key)
      }
      events.push({
        type: 'assistant',
        message: msg,
        uuid: row.uuid || null,
        replay_id: buildAssistantReplayId(row),
        parent_tool_use_id: row.parent_tool_use_id || null,
      })
    }
  }

  return events
}

/**
 * Parse the TAIL of a large jsonl file — reads only the last TAIL_BYTES bytes
 * so we don't load the entire file into memory for sessions with 10K+ events.
 * We still need to decode enough events for INITIAL_HISTORY_BLOCKS (200) in
 * the front-end plus some margin for dedup.  With typical event sizes of a
 * few KB each, 4 MB of tail covers 500–2000 events — enough for any scroll depth.
 *
 * Returns the same format as parseJsonlHistory but only includes events from the
 * tail window.  For files smaller than TAIL_BYTES it falls back to the full read.
 */
const TAIL_BYTES = 4 * 1024 * 1024  // 4 MB

/**
 * Internal helper: read TAIL_BYTES ending at `endOffset` (exclusive) from a file.
 * Returns parsed raw rows array, or null on error.
 * `endOffset` defaults to file end if not provided.
 */
function _readChunkBefore(jsonlPath, endOffset) {
  let fileSize = 0
  try { fileSize = statSync(jsonlPath).size } catch { return null }

  const safeEnd = Math.min(endOffset ?? fileSize, fileSize)
  if (safeEnd <= 0) return []

  const readStart = Math.max(0, safeEnd - TAIL_BYTES)
  const readLen = safeEnd - readStart

  let chunk
  try {
    const fd = openSync(jsonlPath, 'r')
    const buf = Buffer.allocUnsafe(readLen)
    let bytesRead = 0
    try {
      bytesRead = readSync(fd, buf, 0, readLen, readStart)
    } finally {
      closeSync(fd)
    }
    chunk = buf.slice(0, bytesRead).toString('utf-8')
  } catch {
    return null
  }

  // First line may be partial if we jumped mid-line; drop it.
  if (readStart > 0) {
    const firstNewline = chunk.indexOf('\n')
    chunk = firstNewline >= 0 ? chunk.slice(firstNewline + 1) : ''
  }

  const rawRows = []
  for (const line of chunk.split('\n')) {
    if (!line.trim()) continue
    let row
    try { row = JSON.parse(line) } catch { continue }
    rawRows.push(row)
  }
  return rawRows
}

/**
 * Convert raw rows to events using the same dedup logic as parseJsonlHistory.
 */
function _rawRowsToEvents(rawRows) {
  const replayState = { userTextCounts: new Map() }
  const events = []

  const assistantByKey = new Map()
  for (const row of rawRows) {
    if (row.type !== 'assistant') continue
    const rid = row.requestId
    if (!rid) continue
    const msg = row.message
    if (!msg || !Array.isArray(msg.content) || msg.content.length === 0) continue
    const firstType = msg.content[0]?.type || 'unknown'
    const key = `${rid}:${firstType}`
    assistantByKey.set(key, row)
  }

  const emittedKeys = new Set()
  for (const row of rawRows) {
    if (row.type === 'user') {
      const msg = row.message
      if (!msg || !msg.content) continue
      events.push({
        type: 'user',
        message: msg,
        uuid: row.uuid || null,
        replay_id: buildUserReplayId(extractReplayUserText(msg), replayState.userTextCounts),
        parent_tool_use_id: row.parent_tool_use_id || null,
      })
    } else if (row.type === 'assistant') {
      const msg = row.message
      if (!msg || !Array.isArray(msg.content)) continue
      const rid = row.requestId
      if (rid) {
        const firstType = msg.content[0]?.type || 'unknown'
        const key = `${rid}:${firstType}`
        if (assistantByKey.get(key) !== row) continue
        if (emittedKeys.has(key)) continue
        emittedKeys.add(key)
      }
      events.push({
        type: 'assistant',
        message: msg,
        uuid: row.uuid || null,
        replay_id: buildAssistantReplayId(row),
        parent_tool_use_id: row.parent_tool_use_id || null,
      })
    }
  }
  return events
}

export function parseJsonlHistoryTail(jsonlPath) {
  let fileSize = 0
  try { fileSize = statSync(jsonlPath).size } catch { return [] }

  // Small file: use the full parser (no point seeking)
  if (fileSize <= TAIL_BYTES) return parseJsonlHistory(jsonlPath)

  const rawRows = _readChunkBefore(jsonlPath, fileSize)
  if (!rawRows) return []
  return _rawRowsToEvents(rawRows)
}

/**
 * Parse events BEFORE a given event UUID in a large jsonl.
 * Strategy:
 *   1. Scan the full file to find the byte offset of the line containing `beforeUuid`.
 *   2. Read TAIL_BYTES ending at that offset.
 *   3. Parse and return events; include hasMore=true if there are bytes before the window.
 *
 * Returns { events, hasMore, firstUuid } where firstUuid is the uuid of the oldest
 * returned event (for the next pagination request).
 */
export function parseJsonlHistoryBefore(jsonlPath, beforeUuid) {
  let fileSize = 0
  try { fileSize = statSync(jsonlPath).size } catch { return { events: [], hasMore: false } }

  // We need to find the byte offset of the line with beforeUuid.
  // For a 73MB file, scanning line by line with node's fs is too slow.
  // Strategy: read in TAIL_BYTES chunks from the end until we find it,
  // or fall back to a full scan if the uuid is very old.
  // We track the byte offset by scanning the file in reverse chunks.

  let targetEndOffset = null  // byte offset just before the line containing beforeUuid

  // Walk the file in TAIL_BYTES chunks from the end
  let scanEnd = fileSize
  let found = false
  const MAX_SCAN_CHUNKS = 20  // scan at most 80 MB backward — enough for any session
  for (let attempt = 0; attempt < MAX_SCAN_CHUNKS && !found; attempt++) {
    const scanStart = Math.max(0, scanEnd - TAIL_BYTES)
    let chunkBuf
    try {
      const fd = openSync(jsonlPath, 'r')
      const buf = Buffer.allocUnsafe(scanEnd - scanStart)
      let br = 0
      try { br = readSync(fd, buf, 0, buf.length, scanStart) } finally { closeSync(fd) }
      chunkBuf = buf.slice(0, br).toString('utf-8')
    } catch { break }

    // Drop partial first line if we didn't start at position 0
    let chunkLines
    let lineStartOffset = scanStart  // byte offset of chunk start
    if (scanStart > 0) {
      const fi = chunkBuf.indexOf('\n')
      if (fi >= 0) {
        lineStartOffset = scanStart + fi + 1
        chunkBuf = chunkBuf.slice(fi + 1)
      }
    }

    // Split into lines and track byte offsets
    // (approximate: assume utf-8 byte length equals char count for ASCII lines)
    const rawLines = chunkBuf.split('\n')
    let bytePos = lineStartOffset
    const lineInfos = []
    for (const rawLine of rawLines) {
      const lineByteLen = Buffer.byteLength(rawLine, 'utf-8') + 1  // +1 for \n
      if (rawLine.trim()) {
        lineInfos.push({ line: rawLine, startOffset: bytePos })
      }
      bytePos += lineByteLen
    }

    // Search for beforeUuid (iterate backwards within chunk to find the line)
    for (let li = lineInfos.length - 1; li >= 0; li--) {
      const { line, startOffset } = lineInfos[li]
      if (!line.includes(beforeUuid)) continue
      let row
      try { row = JSON.parse(line) } catch { continue }
      if (row.uuid === beforeUuid) {
        targetEndOffset = startOffset  // read events ending just before this line
        found = true
        break
      }
    }

    if (scanStart === 0) break  // scanned entire file
    scanEnd = scanStart + 1  // overlap by 1 byte to avoid missing lines at chunk boundary
  }

  if (!found || targetEndOffset === null) {
    // UUID not found — return empty; front-end will hide the button
    return { events: [], hasMore: false }
  }

  if (targetEndOffset === 0) {
    // The found event is the very first line — nothing before it
    return { events: [], hasMore: false }
  }

  const hasMore = targetEndOffset > TAIL_BYTES
  const rawRows = _readChunkBefore(jsonlPath, targetEndOffset)
  if (!rawRows) return { events: [], hasMore: false }

  const events = _rawRowsToEvents(rawRows)
  const firstUuid = events.length > 0 ? (events[0].uuid || null) : null

  return { events, hasMore, firstUuid }
}

/**
 * Find the most-recently-modified .jsonl in a project directory.
 * Returns { path, sessionId } or null.
 */
export function findNewestJsonl(projectDir) {
  if (!existsSync(projectDir)) return null
  let best = null
  let bestMtime = 0
  try {
    const entries = readdirSync(projectDir)
    for (const entry of entries) {
      if (!entry.endsWith('.jsonl')) continue
      const fullPath = join(projectDir, entry)
      try {
        const st = statSync(fullPath)
        if (st.mtimeMs > bestMtime) {
          bestMtime = st.mtimeMs
          best = { path: fullPath, sessionId: entry.replace(/\.jsonl$/, '') }
        }
      } catch {}
    }
  } catch {}
  return best
}

export function createClaudeHistoryService({ store, home, recentAgents, sessionController }) {
  function syncResolvedSession(projectId, tabId, sessionId) {
    if (store.updateTabMetadata) {
      store.updateTabMetadata(projectId, tabId, { claudeSessionId: sessionId })
    }
    sessionController.setClaudeSessionId(projectId, tabId, sessionId, { resetTurnCount: true })
  }

  function findMostRecentClaudeTab(project) {
    const tabs = store.listTabs(project.id).filter((t) => t.type === 'claude')
    if (!tabs.length) return null

    const projectDir = cwdToClaudeProjectDir(home, project.cwd)
    let bestTabId = null
    let bestMtime = 0

    for (const tab of tabs) {
      if (!tab.claudeSessionId) continue
      const jsonlPath = join(projectDir, `${tab.claudeSessionId}.jsonl`)
      try {
        if (existsSync(jsonlPath)) {
          const st = statSync(jsonlPath)
          if (st.mtimeMs > bestMtime) {
            bestMtime = st.mtimeMs
            bestTabId = tab.id
          }
        }
      } catch {}
    }

    if (!bestTabId && tabs.length > 0) bestTabId = tabs[0].id
    return bestTabId
  }

  function handleHistory(req, res) {
    const project = store.getProject(req.params.id)
    if (!project) return res.status(404).json({ error: 'project not found' })
    const tab = store.getTab ? store.getTab(req.params.id, req.params.tabId) : null
    if (!tab || tab.type !== 'claude') {
      return res.status(404).json({ error: 'claude tab not found' })
    }

    const projectDir = cwdToClaudeProjectDir(home, project.cwd)
    const sessionId = tab.claudeSessionId
    const jsonlPath = sessionId ? join(projectDir, `${sessionId}.jsonl`) : null

    let resolvedPath = null
    let resolvedSessionId = sessionId
    let fallback = false

    // CASE A: Tab has an explicit claudeSessionId and the jsonl file exists.
    // Always read it for display — reading a file never causes lock conflicts.
    // The guard preventing --resume on the active session lives in attachClaudeSession
    // (claude-session-controller.js), not here.
    //
    // Historical note: commit 989f0ba added an active-session-guard here that
    // blocked reading when sessionId === CLAUDE_CODE_SESSION_ID.  This was too
    // aggressive: users clicking "Recent Agents" to view their active session
    // saw "[Restored 1 event(s)]" instead of the full history because the guard
    // fired and the fallback assigned a fresh UUID instead of reading the jsonl.
    if (jsonlPath && existsSync(jsonlPath)) {
      resolvedPath = jsonlPath
    } else {
      // CASE B: No explicit sessionId or jsonl file missing — fall back to
      // newest jsonl in the project dir (auto-resume behaviour).
      // The active-session guard applies HERE to the fallback path only, because
      // this path would otherwise silently --resume the main session on the first
      // user turn, causing a lock conflict.
      const autoResumeSetting = store.getSetting('claude_autoresume')
      const autoResumeEnabled = autoResumeSetting !== '0'
      if (autoResumeEnabled) {
        const newest = findNewestJsonl(projectDir)
        if (newest) {
          const mainSessionId = process.env.CLAUDE_CODE_SESSION_ID
          const isMainSession = mainSessionId && newest.sessionId === mainSessionId
          const ACTIVE_THRESHOLD_MS = 30_000
          let isRecentlyWritten = false
          try {
            const st = statSync(newest.path)
            isRecentlyWritten = (Date.now() - st.mtimeMs) < ACTIVE_THRESHOLD_MS
          } catch {}
          let isFileHeld = false
          if (!isMainSession && !isRecentlyWritten) {
            try {
              const r = spawnSync('lsof', ['-t', newest.path], { encoding: 'utf8', timeout: 1000 })
              isFileHeld = r.status === 0 && r.stdout.trim().length > 0
            } catch {}
          }
          if (isMainSession || isRecentlyWritten || isFileHeld) {
            console.log(
              `[history:fallback-skipped] tab=${req.params.tabId} newest jsonl ${newest.sessionId} ` +
              `is active (mainSession=${isMainSession}, recentWrite=${isRecentlyWritten}, lsof=${isFileHeld}) - starting fresh`
            )
            const freshId = randomUUID()
            resolvedSessionId = freshId
            if (store.updateTabMetadata) {
              store.updateTabMetadata(req.params.id, req.params.tabId, { claudeSessionId: freshId })
            }
            sessionController.setClaudeSessionId(req.params.id, req.params.tabId, freshId, { resetTurnCount: true })
            console.log(
              `[history:fallback-skipped] tab=${req.params.tabId} assigned fresh sessionId=${freshId}`
            )
          } else {
            resolvedPath = newest.path
            resolvedSessionId = newest.sessionId
            fallback = true
            if (resolvedSessionId !== sessionId) {
              syncResolvedSession(req.params.id, req.params.tabId, resolvedSessionId)
            }
            console.log(`[history:fallback] tab=${req.params.tabId} using newest jsonl: ${resolvedSessionId}`)
          }
        }
      } else {
        console.log(`[history:fallback-skipped] tab=${req.params.tabId} auto-resume disabled, returning empty history`)
      }
    }

    if (!resolvedPath) {
      sessionController.primeReplayHistory(req.params.id, req.params.tabId, [])
      recentAgents.primeRecentAgentsCache()
      return res.json({ events: [], sessionId: resolvedSessionId, fallback })
    }

    // ── Pagination: ?before=<uuid> fetches events older than the given uuid ──
    const beforeUuid = typeof req.query.before === 'string' ? req.query.before.trim() : null
    if (beforeUuid) {
      // Load earlier page — do NOT update primeReplayHistory (that's for initial load only)
      const { events, hasMore, firstUuid } = parseJsonlHistoryBefore(resolvedPath, beforeUuid)
      console.log(`[history:before] tab=${req.params.tabId} before=${beforeUuid} events=${events.length} hasMore=${hasMore}`)
      return res.json({ events, hasMore, firstUuid, sessionId: resolvedSessionId })
    }

    // Use tail-reader for large files to avoid loading the entire jsonl into memory.
    // parseJsonlHistoryTail reads only the last 4 MB (≈500-2000 events) which is
    // more than enough for the front-end's INITIAL_HISTORY_BLOCKS (200) + lazy pages.
    const events = parseJsonlHistoryTail(resolvedPath)
    // Determine if there's more history before the tail window
    let fileSize = 0
    try { fileSize = statSync(resolvedPath).size } catch {}
    const hasMore = fileSize > TAIL_BYTES
    const firstUuid = events.length > 0 ? (events[0].uuid || null) : null

    sessionController.primeReplayHistory(req.params.id, req.params.tabId, events)
    recentAgents.primeRecentAgentsCache()
    console.log(`[history] tab=${req.params.tabId} sessionId=${resolvedSessionId} events=${events.length} hasMore=${hasMore} fallback=${fallback}`)
    res.json({ events, hasMore, firstUuid, sessionId: resolvedSessionId, fallback })
  }

  return {
    cwdToClaudeProjectDir: (cwd) => cwdToClaudeProjectDir(home, cwd),
    findMostRecentClaudeTab,
    handleHistory,
  }
}
