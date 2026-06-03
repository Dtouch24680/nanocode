/** Terminal routes — Express Router + WebSocket handler. */

import { Router } from 'express'
import { execFile, spawn } from 'node:child_process'
import { platform } from 'node:os'
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import { resolve, relative, isAbsolute, join } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import * as sessions from './sessions.js'

/**
 * Create terminal routes backed by the given store.
 */
export function createTerminalRoutes(store) {
  const router = Router()
  const home = homedir()

  /** Parse ~/.ssh/config into an array of host objects. */
  function parseSshConfig(content) {
    const hosts = []
    let current = null
    for (const raw of content.split('\n')) {
      const line = raw.trim()
      if (!line || line.startsWith('#')) continue
      const match = line.match(/^(\S+)\s+(.+)$/)
      if (!match) continue
      const [, key, value] = match
      const k = key.toLowerCase()
      if (k === 'host') {
        if (value.includes('*')) { current = null; continue }
        current = { name: value, hostname: null, user: null, port: null, identityFile: null }
        hosts.push(current)
      } else if (current) {
        if (k === 'hostname') current.hostname = value
        else if (k === 'user') current.user = value
        else if (k === 'port') current.port = parseInt(value, 10) || null
        else if (k === 'identityfile') current.identityFile = value
      }
    }
    return hosts.filter((h) => h.hostname && h.hostname !== 'github.com')
  }

  router.get('/api/ssh-hosts', (_req, res) => {
    const configPath = join(home, '.ssh', 'config')
    if (!existsSync(configPath)) return res.json([])
    try {
      const content = readFileSync(configPath, 'utf-8')
      res.json(parseSshConfig(content))
    } catch {
      res.json([])
    }
  })

  router.get('/api/projects', (_req, res) => {
    res.json(store.listProjects())
  })

  router.post('/api/projects', (req, res) => {
    const { name, cwd, ssh_host, ssh_user, ssh_port, ssh_key } = req.body || {}
    if (!name || !cwd) {
      return res.status(400).json({ error: 'name and cwd required' })
    }
    const ssh = ssh_host ? { host: ssh_host, user: ssh_user, port: ssh_port, key: ssh_key } : {}
    const project = store.createProject(name, cwd, null, ssh)
    res.status(201).json(project)
  })

  router.delete('/api/projects/:id', (req, res) => {
    const project = store.getProject(req.params.id)
    if (!project) {
      return res.status(404).json({ error: 'project not found' })
    }
    sessions.destroySessions(req.params.id)
    store.removeProject(req.params.id)
    res.status(204).send()
  })

  router.post('/api/projects/:id/test-ssh', (req, res) => {
    const project = store.getProject(req.params.id)
    if (!project) {
      return res.status(404).json({ error: 'project not found' })
    }
    if (!project.ssh_host) {
      return res.status(400).json({ error: 'project is not remote' })
    }
    const args = [
      '-o', 'ConnectTimeout=5',
      '-o', 'StrictHostKeyChecking=accept-new',
      '-p', String(project.ssh_port || 22),
    ]
    if (project.ssh_key) args.push('-i', project.ssh_key)
    args.push(`${project.ssh_user || 'root'}@${project.ssh_host}`, 'echo ok')
    execFile('ssh', args, { timeout: 10000 }, (err, stdout) => {
      if (err) return res.json({ ok: false, error: err.message })
      res.json({ ok: stdout.trim() === 'ok' })
    })
  })

  router.get('/api/projects/:id/sessions', (req, res) => {
    const project = store.getProject(req.params.id)
    if (!project) {
      return res.status(404).json({ error: 'project not found' })
    }
    res.json(sessions.listProjectSessions(req.params.id))
  })

  router.delete('/api/projects/:id/sessions/bash/:tabId', (req, res) => {
    const project = store.getProject(req.params.id)
    if (!project) {
      return res.status(404).json({ error: 'project not found' })
    }
    sessions.destroySession(`${req.params.id}:bash:${req.params.tabId}`)
    res.status(204).send()
  })

  // --- Tab registry (per-project, persisted in store) ---
  //
  // Tabs are server-side metadata so that opening the workspace on a second
  // device reattaches to the same PTYs (matches original-nanocode behavior
  // where the project had a single shared bash session). The PTY itself is
  // still in-memory; on server restart the tab metadata survives but bash
  // respawns fresh on next attach.

  /** projectId → Set<WebSocket> for live tab-list broadcasts. */
  const tabSubscribers = new Map()

  function broadcastTabs(projectId) {
    const subs = tabSubscribers.get(projectId)
    if (!subs || !subs.size) return
    const payload = JSON.stringify({
      type: 'tabs:update',
      projectId,
      tabs: store.listTabs(projectId),
    })
    for (const ws of subs) {
      if (ws.readyState === 1) {
        try { ws.send(payload) } catch {}
      }
    }
  }

  router.get('/api/projects/:id/tabs', (req, res) => {
    const project = store.getProject(req.params.id)
    if (!project) return res.status(404).json({ error: 'project not found' })
    res.json(store.listTabs(req.params.id))
  })

  /**
   * GET /api/projects/:id/most-recent-claude-tab
   *
   * Returns the claude tab whose session jsonl has the most recent mtime, or
   * null if no claude tabs exist / no jsonl files found. Used by the frontend
   * to auto-select the most recently active claude tab when entering a workspace.
   *
   * Response: { tabId: string | null }
   */
  router.get('/api/projects/:id/most-recent-claude-tab', (req, res) => {
    const project = store.getProject(req.params.id)
    if (!project) return res.status(404).json({ error: 'project not found' })

    const tabs = store.listTabs(req.params.id).filter((t) => t.type === 'claude')
    if (!tabs.length) return res.json({ tabId: null })

    const projectDir = cwdToClaudeProjectDir(project.cwd)
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

    // If no matching jsonl found for any tab, fall back to first claude tab
    if (!bestTabId && tabs.length > 0) bestTabId = tabs[0].id

    res.json({ tabId: bestTabId })
  })

  router.post('/api/projects/:id/tabs', (req, res) => {
    const project = store.getProject(req.params.id)
    if (!project) return res.status(404).json({ error: 'project not found' })
    const label = typeof req.body?.label === 'string' && req.body.label.trim()
      ? req.body.label.trim().slice(0, 40)
      : undefined
    const type = typeof req.body?.type === 'string' ? req.body.type : undefined
    const tab = store.createTab(req.params.id, { label, type })
    broadcastTabs(req.params.id)
    res.status(201).json(tab)
  })

  router.patch('/api/projects/:id/tabs/:tabId', (req, res) => {
    const project = store.getProject(req.params.id)
    if (!project) return res.status(404).json({ error: 'project not found' })
    const label = typeof req.body?.label === 'string' && req.body.label.trim()
      ? req.body.label.trim().slice(0, 40)
      : null
    if (!label) return res.status(400).json({ error: 'label required' })
    const tab = store.renameTab(req.params.id, req.params.tabId, label)
    if (!tab) return res.status(404).json({ error: 'tab not found' })
    broadcastTabs(req.params.id)
    res.json(tab)
  })

  router.delete('/api/projects/:id/tabs/:tabId', (req, res) => {
    const project = store.getProject(req.params.id)
    if (!project) return res.status(404).json({ error: 'project not found' })
    const removed = store.removeTab(req.params.id, req.params.tabId)
    sessions.destroySession(`${req.params.id}:bash:${req.params.tabId}`)
    if (removed) broadcastTabs(req.params.id)
    res.status(removed ? 204 : 404).send()
  })

  /**
   * /ws/tabs handler — clients send `{type:'subscribe', projectId}` and
   * receive `{type:'tabs:update', projectId, tabs:[]}` on every mutation
   * (and once immediately as a snapshot).
   */
  function handleTabsWs(ws) {
    let subscribed = null
    const unsubscribe = () => {
      if (!subscribed) return
      const subs = tabSubscribers.get(subscribed)
      if (subs) {
        subs.delete(ws)
        if (subs.size === 0) tabSubscribers.delete(subscribed)
      }
      subscribed = null
    }
    ws.on('message', (raw) => {
      let msg
      try { msg = JSON.parse(raw) } catch { return }
      if (msg.type === 'subscribe' && typeof msg.projectId === 'string') {
        if (subscribed !== msg.projectId) {
          unsubscribe()
          subscribed = msg.projectId
          if (!tabSubscribers.has(subscribed)) tabSubscribers.set(subscribed, new Set())
          tabSubscribers.get(subscribed).add(ws)
        }
        ws.send(JSON.stringify({
          type: 'tabs:update',
          projectId: subscribed,
          tabs: store.listTabs(subscribed),
        }))
      } else if (msg.type === 'ping') {
        try { ws.send(JSON.stringify({ type: 'pong', id: msg.id })) } catch {}
      }
    })
    ws.on('close', unsubscribe)
    ws.on('error', unsubscribe)
  }

  // Folder browser for the Add-project dialog.
  //
  // Accepts any absolute path the server-side user can read — we
  // deliberately do NOT sandbox to $HOME because projects often live
  // under /opt, /srv, /var/www, etc. The filesystem's own permission
  // checks (readdirSync → EACCES) remain the authorization boundary.
  // Relative paths or empty path default to $HOME for convenience.
  router.get('/api/fs', (req, res) => {
    const raw = req.query.path
    const input = raw && String(raw).trim() ? String(raw).trim() : null
    const base = input ? (isAbsolute(input) ? resolve(input) : resolve(home, input)) : home

    try {
      const entries = readdirSync(base, { withFileTypes: true })
        .filter((dirent) => dirent.isDirectory() && !dirent.name.startsWith('.'))
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
        .map((dirent) => ({ name: dirent.name, isDir: true }))
      res.json({ path: base, entries })
    } catch (err) {
      if (err.code === 'ENOENT') return res.status(404).json({ error: 'not found' })
      if (err.code === 'ENOTDIR')
        return res.status(400).json({ error: 'not a directory' })
      if (err.code === 'EACCES') return res.status(403).json({ error: 'permission denied' })
      res.status(500).json({ error: err.message })
    }
  })

  // ── Claude history replay from ~/.claude/projects/<cwd-encoded>/<sessionId>.jsonl ──────
  //
  // Encoding rule (verified empirically): replace every '/' in the cwd with '-'.
  // e.g. /storage/home/user/code/nanocode → -storage-home-user-code-nanocode
  //
  // jsonl rows with type 'user' or 'assistant' map 1:1 to renderer events:
  //   - 'user' row → {type:'user', message:{role:'user',content:[...]}, uuid, parent_tool_use_id}
  //   - 'assistant' row → {type:'assistant', message:{role:'assistant',content:[...]}, uuid, parent_tool_use_id}
  //   - all other types (queue-operation, attachment, last-prompt, mode) → skip
  //
  // Multiple 'assistant' rows for same turn (streaming): only the LAST one for each
  // chain uuid is the complete message. We de-dup by keeping the last assistant
  // row seen for each requestId (or uuid if no requestId).

  function cwdToClaudeProjectDir(cwd) {
    const encoded = cwd.replace(/\//g, '-')
    return join(home, '.claude', 'projects', encoded)
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
  function parseJsonlHistory(jsonlPath) {
    let content
    try {
      content = readFileSync(jsonlPath, 'utf-8')
    } catch {
      return []
    }

    const lines = content.split('\n').filter((l) => l.trim())
    const events = []

    // Collect all rows first
    const rawRows = []
    for (const line of lines) {
      let row
      try { row = JSON.parse(line) } catch { continue }
      rawRows.push(row)
    }

    // De-duplicate assistant rows: for each requestId (streaming session),
    // keep only the last row (most complete). Rows without requestId are kept as-is.
    // We process in order and overwrite by requestId.
    const assistantByRequestId = new Map()  // requestId → row
    const assistantNoRequestId = []  // rows without requestId (not streaming)
    const processedUuids = new Set()

    for (const row of rawRows) {
      if (row.type !== 'assistant') continue
      const rid = row.requestId
      if (rid) {
        assistantByRequestId.set(rid, row)  // overwrite → last wins
      } else {
        assistantNoRequestId.push(row)
      }
    }

    // Build the final event list in document order
    // We want: user rows interleaved with the de-duped assistant rows, in original order.
    // Walk rawRows; for assistant rows with requestId, only emit when it's the LAST
    // occurrence of that requestId (i.e., when we reach the row we stored in the map).
    for (const row of rawRows) {
      if (row.type === 'user') {
        const msg = row.message
        if (!msg || !msg.content) continue
        // Skip tool-result-only rows where content is system/hook noise
        // (pure tool results are still useful — render them)
        events.push({
          type: 'user',
          message: msg,
          uuid: row.uuid || null,
          parent_tool_use_id: row.parent_tool_use_id || null,
        })
      } else if (row.type === 'assistant') {
        const msg = row.message
        if (!msg || !Array.isArray(msg.content)) continue
        const rid = row.requestId
        if (rid) {
          // Only emit the last row for this requestId
          if (assistantByRequestId.get(rid) !== row) continue
        }
        events.push({
          type: 'assistant',
          message: msg,
          uuid: row.uuid || null,
          parent_tool_use_id: row.parent_tool_use_id || null,
        })
      }
      // Skip: queue-operation, attachment, last-prompt, mode, etc.
    }

    return events
  }

  /**
   * Find the most-recently-modified .jsonl in a project directory.
   * Returns { path, sessionId } or null.
   */
  function findNewestJsonl(projectDir) {
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

  /**
   * GET /api/projects/:id/tabs/:tabId/history
   *
   * Returns the replay history for a claude tab by reading the session's jsonl.
   * Falls back to the newest jsonl if the tab's session file is missing.
   * If the fallback is used, the response includes the resolved sessionId so
   * the client (and server) can update the tab's claudeSessionId for --resume alignment.
   *
   * Response: { events: [{type, message, uuid, parent_tool_use_id}], sessionId, fallback: bool }
   */
  router.get('/api/projects/:id/tabs/:tabId/history', (req, res) => {
    const project = store.getProject(req.params.id)
    if (!project) return res.status(404).json({ error: 'project not found' })
    const tab = store.getTab ? store.getTab(req.params.id, req.params.tabId) : null
    if (!tab || tab.type !== 'claude') {
      return res.status(404).json({ error: 'claude tab not found' })
    }

    const projectDir = cwdToClaudeProjectDir(project.cwd)
    const sessionId = tab.claudeSessionId
    const jsonlPath = sessionId ? join(projectDir, `${sessionId}.jsonl`) : null

    let resolvedPath = null
    let resolvedSessionId = sessionId
    let fallback = false

    if (jsonlPath && existsSync(jsonlPath)) {
      resolvedPath = jsonlPath
    } else {
      // Fallback: find newest jsonl in this project's directory
      const newest = findNewestJsonl(projectDir)
      if (newest) {
        resolvedPath = newest.path
        resolvedSessionId = newest.sessionId
        fallback = true
        // Update the store so --resume uses the right session
        if (store.updateTabMetadata && resolvedSessionId !== sessionId) {
          store.updateTabMetadata(req.params.id, req.params.tabId, {
            claudeSessionId: resolvedSessionId,
          })
          // Also update the in-memory claudeSessions map if the session exists
          const sessionKey = `${req.params.id}:claude:${req.params.tabId}`
          const cs = claudeSessions.get(sessionKey)
          if (cs) {
            cs.claudeSessionId = resolvedSessionId
            cs.turnCount = 0  // reset so next turn uses --session-id not --resume with wrong id
          }
        }
        console.log(`[history:fallback] tab=${req.params.tabId} using newest jsonl: ${resolvedSessionId}`)
      }
    }

    if (!resolvedPath) {
      return res.json({ events: [], sessionId: resolvedSessionId, fallback })
    }

    const events = parseJsonlHistory(resolvedPath)
    console.log(`[history] tab=${req.params.tabId} sessionId=${resolvedSessionId} events=${events.length} fallback=${fallback}`)
    res.json({ events, sessionId: resolvedSessionId, fallback })
  })

  const IS_WIN = platform() === 'win32'
  const SHELL = IS_WIN
    ? (process.env.COMSPEC || 'C:\\Windows\\System32\\cmd.exe')
    : 'bash'
  const SSH = IS_WIN ? 'C:\\Windows\\System32\\OpenSSH\\ssh.exe' : 'ssh'

  // Shell-quoted command-line for each tab type.
  //
  // All coding agents launch in their "max permissions / no approvals"
  // mode — nanocode is intended for single-user-trusted-host workflows
  // and the per-user uid drop (the worker runs as the invoking user,
  // never root) is the real authorization boundary, not the agent's
  // in-process prompt-before-action gate.
  //
  // When the agent exits (via /exit, Ctrl+C, etc.) the chained
  // `exec bash -l` takes over the same PTY so the tab drops into a
  // raw login shell instead of getting stuck in the dead state the
  // original nanocode left.
  const TAB_LAUNCHERS = {
    bash: () => 'exec bash -l',
    // Claude Code: bypass all permission checks.
    // When auto-resume is enabled (default), wrap in a shell loop that:
    //   1. runs claude with --dangerously-skip-permissions
    //   2. on exit, shows a 3-second countdown with "press any key for bash"
    //   3. if no key pressed, runs `claude --continue` to resume the last session
    //      (gracefully falls back to plain `claude` if --continue exits quickly
    //       indicating no prior session)
    //   4. if the user presses any key, falls through to `exec bash -l`
    // When auto-resume is disabled, falls back to simple one-shot + bash.
    claude: () => {
      const autoResume = store.getSetting('claude_autoresume')
      // Default is enabled (null means not yet set → treat as enabled)
      const enabled = autoResume !== '0'
      if (!enabled) {
        return 'claude --dangerously-skip-permissions; exec bash -l'
      }
      // Shell loop with countdown escape hatch.
      // The inner function `_claude_resume_loop` is defined in-line:
      //   - First iteration: plain claude (fresh or first run)
      //   - Subsequent iterations: claude --continue (resume last session)
      //   - On each exit, countdown 3s; any keypress → break → exec bash
      //   - `claude --continue` exits 0 even if there's no session; we detect
      //     a "no session found" scenario by checking if it exits nearly instantly
      //     (< 2s wall time) — if so, we stop looping to avoid a tight crash loop.
      return [
        'set +H;',                        // disable ! history expansion in bash
        '_cbr_first=1;',
        '_cbr_continue() {',
        '  while true; do',
        '    if [ "$_cbr_first" = "1" ]; then',
        '      _cbr_first=0;',
        '      claude --dangerously-skip-permissions;',
        '    else',
        '      _cbr_start=$SECONDS;',
        '      claude --continue --dangerously-skip-permissions;',
        '      _cbr_elapsed=$(( SECONDS - _cbr_start ));',
        '      if [ "$_cbr_elapsed" -lt 2 ]; then',
        '        echo "[nanocode] claude --continue failed quickly (no session?), dropping to bash";',
        '        break;',
        '      fi;',
        '    fi;',
        '    echo "";',
        '    echo "[nanocode] Claude exited. Press any key within 3s to stay in bash, or wait to auto-resume...";',
        '    _cbr_key="";',
        '    read -r -s -n 1 -t 3 _cbr_key;',
        '    if [ -n "$_cbr_key" ]; then',
        '      echo "[nanocode] Dropping to bash (key pressed).";',
        '      break;',
        '    fi;',
        '    echo "[nanocode] Auto-resuming...";',
        '  done;',
        '};',
        '_cbr_continue;',
        'exec bash -l',
      ].join(' ')
    },
    // Codex: skip all approvals AND drop the sandbox.
    codex: () => 'codex --dangerously-bypass-approvals-and-sandbox; exec bash -l',
    // Cursor Agent: `--force` (alias `--yolo`) runs every command unless
    // explicitly denied. `--approve-mcps` pre-approves MCP servers.
    agent: () => 'agent --force --approve-mcps; exec bash -l',
    // OpenCode has no CLI-level dangerous flag — permissions are
    // configured in ~/.config/opencode/. We still launch in the
    // project dir so it picks up any local config.
    opencode: () => 'opencode .; exec bash -l',
  }
  const CODING_AGENT_TYPES = new Set(['claude', 'codex', 'agent', 'opencode'])

  /** Build SSH args for a remote project. */
  function buildSshArgs(project, remoteCmd) {
    const args = [
      '-tt',
      '-o', 'ServerAliveInterval=15',
      '-o', 'ServerAliveCountMax=3',
      '-p', String(project.ssh_port || 22),
    ]
    if (project.ssh_key) args.push('-i', project.ssh_key)
    args.push(`${project.ssh_user || 'root'}@${project.ssh_host}`)
    args.push(`bash -lc ${sq(remoteCmd)}`)
    return args
  }

  /** Shell-escape a string for use inside single quotes. */
  function sq(s) {
    return "'" + s.replace(/'/g, "'\\''") + "'"
  }

  // ── Claude stream-json bridge ─────────────────────────────────────────────────
  //
  // Design: spawn a NEW claude process per user message (--print exits after
  // one response). Session continuity is achieved via --resume <sessionId>.
  // History is accumulated in-memory for reconnect replay.
  //
  // Map: sessionKey → { claudeSessionId, clients, history, busy }
  const claudeSessions = new Map()

  /**
   * Broadcast a claude event JSON object to all clients of a session.
   */
  function claudeBroadcast(cs, event) {
    cs.history.push(event)
    if (cs.history.length > 500) cs.history.shift()
    const msg = JSON.stringify({ type: 'claude-event', event })
    for (const client of cs.clients) {
      if (client.readyState === 1) try { client.send(msg) } catch {}
    }
  }

  /**
   * POST /api/projects/:id/tabs/:tabId/interrupt
   * Sends SIGINT to the currently-running claude subprocess for a session.
   */
  router.post('/api/projects/:id/tabs/:tabId/interrupt', (req, res) => {
    const sessionKey = `${req.params.id}:claude:${req.params.tabId}`
    const cs = claudeSessions.get(sessionKey)
    if (!cs) return res.status(404).json({ error: 'no claude session' })
    if (!cs.busy || !cs.currentProc) return res.json({ ok: false, reason: 'not busy' })
    try {
      // Interrupt scope — "Stop must not kill my sub-agents".
      //
      // We send SIGINT to the SINGLE POSITIVE pid of this turn's `bash -lc claude`
      // child. node's child_process.kill(sig) signals proc.pid only — it never
      // signals the negative process-group id. bash then forwards SIGINT to its
      // foreground child (claude), and claude aborts the current turn.
      //
      // Empirically verified (see .interrupt-probe/, evidence.md):
      //   • A sub-agent / Bash-tool child that was DETACHED into its own session
      //     (setsid / nohup & / run_in_background) SURVIVES this interrupt — both
      //     because the SIGINT is single-pid (not a group signal) and because the
      //     child no longer shares claude's session. (probe1, probe3, probe4)
      //   • A NON-detached, foreground Bash-tool child is terminated — but that is
      //     claude's own abort logic killing the child it is actively waiting on,
      //     NOT an OS signal nanocode sent. nanocode cannot prevent that from the
      //     outside; the fix is to launch survivable work detached. (probe2)
      //   • An in-process Task sub-agent's reasoning necessarily ends when its
      //     parent turn is interrupted — that is harness-level behavior nanocode
      //     cannot change. Only the OS processes a sub-agent detached survive.
      //
      // So nanocode already does the minimal correct thing here: single-pid
      // SIGINT, never a process-group kill, never SIGKILL, no escalation timer.
      // The spawn side additionally isolates the turn in its own process group
      // (detached:true) so no group-scoped signal can ever bleed into detached
      // sub-agent work. Maintain this invariant: never switch to kill(-pid) or
      // add a SIGKILL escalation here.
      cs.currentProc.kill('SIGINT')
      res.json({ ok: true })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  /**
   * Build a child environment for a spawned claude subprocess.
   *
   * We strip session-identity env vars that Claude Code sets on itself so that
   * the child cannot accidentally inherit and *reuse* the parent session ID:
   *
   *   CLAUDE_CODE_SESSION_ID  — the running main session's UUID.  If passed
   *     into a child `claude --session-id=X`, the Claude binary treats the env
   *     var as the authoritative session id and ignores the CLI flag, so X
   *     ends up re-claiming the ALREADY-RUNNING main session → "Session ID
   *     ... is already in use" crash.
   *
   *   CLAUDECODE / CLAUDE_CODE_ENTRYPOINT / AI_AGENT  — housekeeping vars
   *     set by the main Claude Code process; passing them to a nested claude
   *     invocation can confuse telemetry and session tracking.
   *
   * All other env vars (PATH, HOME, NVM, …) are preserved so the child shell
   * resolves `claude` and project dependencies correctly.
   */
  function buildClaudeChildEnv() {
    const STRIP_KEYS = new Set([
      'CLAUDE_CODE_SESSION_ID',
      'CLAUDECODE',
      'CLAUDE_CODE_ENTRYPOINT',
      'CLAUDE_CODE_EXECPATH',
      'CLAUDE_CODE_TMPDIR',
      'AI_AGENT',
    ])
    const env = {}
    for (const [k, v] of Object.entries(process.env)) {
      if (!STRIP_KEYS.has(k)) env[k] = v
    }
    return env
  }

  /**
   * Run one claude turn: spawn claude --print with the user text as a CLI
   * argument. Use --resume <sessionId> for turns 2+ to continue the session.
   */
  function runClaudeTurn(cs, userText, sessionKey, cwd) {
    if (cs.busy) {
      // Enqueue instead of discarding. Broadcast a 'queued' system event so the
      // client can show visual feedback (e.g. "message queued — will run next").
      if (!Array.isArray(cs.queue)) cs.queue = []  // defensive: backfill if session was created before queue field
      cs.queue.push(userText)
      const queuedEvent = {
        type: 'system', subtype: 'queued',
        text: `Message queued (position ${cs.queue.length}). Will run after current turn.`,
      }
      claudeBroadcast(cs, queuedEvent)
      return
    }
    cs.busy = true
    cs.currentProc = null

    // First turn uses --session-id to claim a fixed UUID; subsequent turns
    // use --resume to continue the same conversation.
    const isFirstTurn = cs.turnCount === 0
    const sessionArg = isFirstTurn
      ? `--session-id=${cs.claudeSessionId}`
      : `--resume=${cs.claudeSessionId}`
    cs.turnCount++

    const launchArgs = [
      '--print',
      '--output-format=stream-json',
      '--verbose',
      '--include-partial-messages',
      '--dangerously-skip-permissions',
      sessionArg,
      '--',     // end of flags
      userText,
    ]
    const escapedArgs = launchArgs.map((a) => sq(a))
    const launchCmd = `claude ${escapedArgs.join(' ')}`

    console.log(`[claude:spawn] sessionKey=${sessionKey} turn=${cs.turnCount} len=${userText.length}`)
    const proc = spawn('bash', ['-lc', launchCmd], {
      cwd,
      // Bug-fix: strip CLAUDE_CODE_SESSION_ID and sibling vars so the child
      // claude process does not inherit the main session's UUID and attempt to
      // re-claim an already-live session (causes "Session ID ... is already in
      // use" / exit code 1).  See buildClaudeChildEnv() comment for details.
      env: buildClaudeChildEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
      // detached:true puts this turn's `bash -lc claude …` into its own process
      // group/session (setsid). This is defense-in-depth for the "Stop must not
      // kill my sub-agents" requirement: the interrupt route sends SIGINT to the
      // single positive pid (never the negative process-group id), so isolating
      // the turn in its own group guarantees that even a future group-scoped
      // signal aimed at nanocode can never sweep up work that a sub-agent has
      // detached into ITS own session. Verified by .interrupt-probe/probe4: with
      // detached:true the turn still interrupts cleanly on SIGINT while a
      // sub-agent's detached background child survives. See the interrupt route
      // for the full propagation analysis.
      detached: true,
    })
    // NOTE: we intentionally do NOT call proc.unref() — the turn is the
    // foreground generation and should still die with the worker. detached
    // here is purely for process-group isolation, not for outliving nanocode.
    cs.currentProc = proc

    let lineBuffer = ''

    proc.stdout.on('data', (chunk) => {
      lineBuffer += chunk.toString('utf8')
      const lines = lineBuffer.split('\n')
      lineBuffer = lines.pop()
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue
        let event
        try { event = JSON.parse(trimmed) } catch { continue }
        claudeBroadcast(cs, event)
      }
    })

    proc.stderr.on('data', (chunk) => {
      const text = chunk.toString('utf8').trim()
      if (!text) return
      console.warn(`[claude:stderr] ${sessionKey}: ${text.slice(0, 120)}`)
      const event = { type: 'system', subtype: 'stderr', text }
      claudeBroadcast(cs, event)
    })

    proc.on('exit', (code, signal) => {
      cs.busy = false
      cs.currentProc = null
      // Broadcast a synthetic 'result' event so the frontend knows the turn ended
      // (needed for the thinking-state UI to reset even on interrupt/error)
      const wasInterrupted = signal === 'SIGINT'
      const doneEvent = { type: 'result', subtype: wasInterrupted ? 'interrupted' : 'success' }
      claudeBroadcast(cs, doneEvent)
      if (code !== 0 && code != null && !wasInterrupted) {
        const event = { type: 'system', subtype: 'stderr', text: `claude exited with code ${code}` }
        claudeBroadcast(cs, event)
      }

      // Queue drain: on interrupt we discard queued messages because the user
      // signalled they want to change direction. On normal/error exit we run the
      // next queued turn.
      if (!Array.isArray(cs.queue)) cs.queue = []  // defensive backfill
      if (wasInterrupted) {
        if (cs.queue.length > 0) {
          const discarded = cs.queue.length
          cs.queue = []
          const ev = { type: 'system', subtype: 'info', text: `Queue cleared (${discarded} pending message${discarded > 1 ? 's' : ''} discarded after interrupt).` }
          claudeBroadcast(cs, ev)
        }
      } else if (cs.queue.length > 0) {
        const nextText = cs.queue.shift()
        console.log(`[claude:queue] sessionKey=${sessionKey} running queued turn, ${cs.queue.length} remaining`)
        // Small tick to avoid re-entrancy issues (exit handler → runClaudeTurn synchronously)
        setImmediate(() => runClaudeTurn(cs, nextText, sessionKey, cwd))
      }
    })

    proc.on('error', (err) => {
      cs.busy = false
      cs.currentProc = null
      const doneEvent = { type: 'result', subtype: 'error' }
      claudeBroadcast(cs, doneEvent)
      const event = { type: 'system', subtype: 'spawn_error', text: err.message }
      claudeBroadcast(cs, event)
      // On spawn error, still drain the queue so queued messages are not lost
      if (cs.queue.length > 0) {
        const nextText = cs.queue.shift()
        console.log(`[claude:queue] sessionKey=${sessionKey} running queued turn after spawn error, ${cs.queue.length} remaining`)
        setImmediate(() => runClaudeTurn(cs, nextText, sessionKey, cwd))
      }
    })
  }

  /**
   * Attach a WS client to an existing (or new) claude session.
   * The session key is `${projectId}:claude:${tabId}`.
   */
  function attachClaudeSession(ws, { projectId, tabId, project }) {
    const sessionKey = `${projectId}:claude:${tabId}`
    let cs = claudeSessions.get(sessionKey)

    if (!cs) {
      const tab = store.getTab ? store.getTab(projectId, tabId) : null
      let claudeSessionId = tab?.claudeSessionId || randomUUID()

      // Bug-fix (session-id collision): if the stored UUID matches the currently-running
      // main Claude Code session (CLAUDE_CODE_SESSION_ID), spawning with that ID would
      // try to claim an already-live session and crash with "Session ID is already in use".
      // Generate a fresh UUID instead and persist it so the tab gets a clean identity.
      const mainSessionId = process.env.CLAUDE_CODE_SESSION_ID
      if (mainSessionId && claudeSessionId === mainSessionId) {
        console.warn(
          `[claude:session] Tab ${tabId} stored claudeSessionId collides with the running ` +
          `main session (${mainSessionId}). Generating a fresh UUID to avoid conflict.`
        )
        claudeSessionId = randomUUID()
        if (store.updateTabMetadata) {
          store.updateTabMetadata(projectId, tabId, { claudeSessionId })
        }
      }

      cs = {
        claudeSessionId,
        clients: new Set(),
        history: [],
        busy: false,
        turnCount: 0,
        cwd: project.cwd,
        currentProc: null,
        // FIFO queue for messages arriving while busy.
        // On interrupt (SIGINT) we clear the queue — an interrupted turn means
        // the user wants to change direction, so stale queued messages are
        // discarded. On normal exit, each queued item is shifted off and run
        // in order so the user's messages are never lost.
        queue: [],
      }
      claudeSessions.set(sessionKey, cs)
    }

    // Replay history to newly-connected client
    for (const event of cs.history) {
      if (ws.readyState === 1) {
        try { ws.send(JSON.stringify({ type: 'claude-event', event })) } catch {}
      }
    }

    cs.clients.add(ws)

    const onMsg = (raw) => {
      let msg
      try { msg = JSON.parse(raw) } catch { return }
      if (msg.type === 'claude-input' && typeof msg.text === 'string' && msg.text.trim()) {
        // Store a synthetic 'user' event in history so reconnecting clients can
        // replay user turns and see their own messages after a WS disconnect.
        // The event includes a unique nonce so the client can deduplicate against
        // its locally-echoed block (avoids double-rendering on the same session).
        const userEvent = {
          type: 'user',
          message: { role: 'user', content: [{ type: 'text', text: msg.text }] },
          _nonce: msg._nonce || null,
        }
        claudeBroadcast(cs, userEvent)
        runClaudeTurn(cs, msg.text, sessionKey, project.cwd)
      } else if (msg.type === 'ping') {
        try { ws.send(JSON.stringify({ type: 'pong', id: msg.id })) } catch {}
      }
    }

    ws.on('message', onMsg)
    ws.on('close', () => {
      ws.removeListener('message', onMsg)
      cs.clients.delete(ws)
    })
  }

  function handleTerminalWs(ws) {
    const once = (raw) => {
      let msg
      try {
        msg = JSON.parse(raw)
      } catch {
        return
      }
      if (msg.type !== 'attach') return

      const { projectId, sessionType, cols, rows } = msg
      const tabId = msg.tabId || randomUUID().slice(0, 8)
      if (!projectId || sessionType !== 'bash') return

      const project = store.getProject(projectId)
      if (!project) {
        ws.send(JSON.stringify({ type: 'error', error: 'project not found' }))
        return
      }

      // Authoritatively resolve the tab's type from the server-side store
      // (the client may omit it). Default to 'bash' for legacy tabs.
      const tab = store.getTab ? store.getTab(projectId, tabId) : null
      const tabType = tab?.type || 'bash'
      console.log(`[ws:attach] projectId=${projectId} tabId=${tabId} tabType=${tabType}`)

      // ── Claude tabs: stream-json bridge (no PTY) ─────────────────────────────
      if (tabType === 'claude') {
        console.log(`[ws:attach] routing to claude stream-json bridge`)
        attachClaudeSession(ws, { projectId, tabId, project })
        return
      }

      const launcherFn = TAB_LAUNCHERS[tabType] || TAB_LAUNCHERS.bash
      const launchCmd = launcherFn()

      const sessionKey = `${projectId}:bash:${tabId}`
      const isRemote = !!project.ssh_host
      let command
      let args
      let cwd

      if (isRemote) {
        command = SSH
        args = buildSshArgs(project, `cd ${sq(project.cwd)} && ${launchCmd}`)
        cwd = home
      } else if (tabType === 'bash') {
        command = SHELL
        args = IS_WIN ? [] : ['--login']
        cwd = project.cwd
      } else {
        // Coding agents: wrap in `bash -lc` so we get a login shell
        // environment (PATH, nvm, etc.) AND can chain `; exec bash -l`
        // to fall back to a raw terminal when the agent exits.
        command = 'bash'
        args = ['-lc', launchCmd]
        cwd = project.cwd
      }

      // Persist scrollback per tab so a host reboot leaves the visual
      // state intact — when a new client attaches, the prior buffer
      // (including any TUI's alt-screen output) replays into xterm.js
      // and the user sees what was on screen before the reboot.
      const scrollbackDir = process.env.NANOCODE_SCROLLBACK_DIR
        || (process.env.HOME ? `${process.env.HOME}/.nanocode/scrollback` : null)
      const scrollbackPath = scrollbackDir
        ? `${scrollbackDir}/${projectId}__${tabId}.bin`
        : undefined

      const session = sessions.getOrCreate(
        sessionKey,
        command,
        args,
        Math.max(1, cols || 80),
        Math.max(1, rows || 24),
        cwd,
        scrollbackPath
      )
      session.attach(ws, Math.max(1, cols || 80), Math.max(1, rows || 24))
    }

    ws.once('message', once)
  }

  return { router, handleTerminalWs, handleTabsWs }
}
