/** Terminal routes — Express Router + WebSocket handler. */

import { Router } from 'express'
import { execFile, spawn } from 'node:child_process'
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { resolve, isAbsolute, join } from 'node:path'
import { homedir } from 'node:os'
import * as sessions from './sessions.js'
import { createClaudeHistoryService } from './claude-history.js'
import { createClaudeSessionController } from './claude-session-controller.js'
import { createRecentAgentsService } from './recent-agents.js'

/**
 * Create terminal routes backed by the given store.
 */
export function createTerminalRoutes(store) {
  const router = Router()
  const home = homedir()
  const recentAgents = createRecentAgentsService({ home })
  const sessionController = createClaudeSessionController({ store, home, recentAgents })
  const historyService = createClaudeHistoryService({
    store,
    home,
    recentAgents,
    sessionController,
  })

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
    res.json({ tabId: historyService.findMostRecentClaudeTab(project) })
  })

  router.post('/api/projects/:id/tabs', (req, res) => {
    const project = store.getProject(req.params.id)
    if (!project) return res.status(404).json({ error: 'project not found' })
    const label = typeof req.body?.label === 'string' && req.body.label.trim()
      ? req.body.label.trim().slice(0, 40)
      : undefined
    const type = typeof req.body?.type === 'string' ? req.body.type : undefined
    // Optional: pre-set claudeSessionId so history endpoint immediately finds the right jsonl.
    // Used by the Recent Agents resume flow to avoid a create+patch two-step race.
    const claudeSessionId = typeof req.body?.claudeSessionId === 'string' && req.body.claudeSessionId.trim()
      ? req.body.claudeSessionId.trim()
      : undefined
    const tab = store.createTab(req.params.id, { label, type, claudeSessionId })
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
   * PATCH /api/projects/:id/tabs/:tabId/session
   * Update a claude tab's claudeSessionId so history replay and --resume target
   * the specified session. Used by the agent-list resume flow.
   * Body: { claudeSessionId: string }
   */
  router.patch('/api/projects/:id/tabs/:tabId/session', (req, res) => {
    const project = store.getProject(req.params.id)
    if (!project) return res.status(404).json({ error: 'project not found' })
    const tab = store.getTab ? store.getTab(req.params.id, req.params.tabId) : null
    if (!tab) return res.status(404).json({ error: 'tab not found' })
    if (tab.type !== 'claude') return res.status(400).json({ error: 'not a claude tab' })
    const { claudeSessionId } = req.body || {}
    if (!claudeSessionId || typeof claudeSessionId !== 'string') {
      return res.status(400).json({ error: 'claudeSessionId required' })
    }
    const updated = store.updateTabMetadata
      ? store.updateTabMetadata(req.params.id, req.params.tabId, { claudeSessionId })
      : null
    if (!updated) return res.status(404).json({ error: 'update failed' })
    sessionController.setClaudeSessionId(req.params.id, req.params.tabId, claudeSessionId)
    res.json(updated)
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

  router.get('/api/projects/:id/tabs/:tabId/history', (req, res) => {
    historyService.handleHistory(req, res)
  })

  // ── GET /api/claude/slash-commands ──────────────────────────────────────────
  //
  // Returns the live list of slash commands supported by the installed claude CLI.
  // Spawns `claude` once with --output-format=stream-json, reads the `init` event
  // which contains a `slash_commands` string[] array, and caches the result for
  // TTL_SLASH_MS (1 hour).  Supports ?refresh=1 to force a cache bust.
  //
  // On first call (cache cold) we do NOT block the response — we return the
  // built-in fallback list immediately and kick off the background fetch.
  // Subsequent calls (cache warm) return immediately.
  //
  // Response: { commands: [{ cmd: string, hint: string }] }
  //
  let _slashCommandsCache = null   // { items: [{cmd,hint}][], ts: number }
  const TTL_SLASH_MS = 60 * 60 * 1000  // 1 hour
  // Fallback list used before the first successful fetch (kept intentionally small
  // — the dynamic fetch will replace it).
  const SLASH_FALLBACK = [
    { cmd: '/clear',    hint: 'Clear conversation history' },
    { cmd: '/compact',  hint: 'Compact context to reduce token usage' },
    { cmd: '/help',     hint: 'Show help and available commands' },
    { cmd: '/exit',     hint: 'Exit Claude Code' },
    { cmd: '/status',   hint: 'Show session status and info' },
    { cmd: '/resume',   hint: 'Resume previous session' },
    { cmd: '/model',    hint: 'Switch Claude model' },
  ]

  let _slashFetchInFlight = false

  /** Spawn claude once, pull slash_commands from the init event.
   *  Resolves with an array of { cmd, hint } objects, or null on failure. */
  function _fetchSlashCommandsFromClaude() {
    return new Promise((resolve) => {
      if (_slashFetchInFlight) { resolve(null); return }
      _slashFetchInFlight = true

      const initMsg = JSON.stringify({
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: 'OK' }] },
      })

      let proc
      try {
        proc = spawn('claude', [
          '--print',
          '--output-format=stream-json',
          '--input-format=stream-json',
          '--verbose',
          '--dangerously-skip-permissions',
        ], {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env },
          cwd: home,
        })
      } catch (err) {
        console.warn('[slash-commands] failed to spawn claude:', err.message)
        _slashFetchInFlight = false
        resolve(null)
        return
      }

      let buf = ''
      let done = false
      const TIMEOUT = 15_000

      const timer = setTimeout(() => {
        if (!done) {
          done = true
          _slashFetchInFlight = false
          try { proc.kill('SIGTERM') } catch {}
          console.warn('[slash-commands] timed out waiting for claude init event')
          resolve(null)
        }
      }, TIMEOUT)

      proc.stdout.on('data', (chunk) => {
        if (done) return
        buf += chunk.toString()
        const lines = buf.split('\n')
        buf = lines.pop()   // keep partial last line
        for (const line of lines) {
          if (!line.trim()) continue
          let obj
          try { obj = JSON.parse(line) } catch { continue }
          if (obj.type === 'system' && obj.subtype === 'init' && Array.isArray(obj.slash_commands)) {
            done = true
            clearTimeout(timer)
            _slashFetchInFlight = false
            try { proc.kill('SIGTERM') } catch {}
            const items = obj.slash_commands.map((name) => ({ cmd: `/${name}`, hint: '' }))
            console.log(`[slash-commands] fetched ${items.length} commands from claude init event`)
            resolve(items)
          }
        }
      })

      proc.on('error', (err) => {
        if (!done) {
          done = true
          clearTimeout(timer)
          _slashFetchInFlight = false
          console.warn('[slash-commands] claude spawn error:', err.message)
          resolve(null)
        }
      })

      proc.on('close', () => {
        if (!done) {
          done = true
          clearTimeout(timer)
          _slashFetchInFlight = false
          resolve(null)
        }
      })

      // Write user turn and close stdin so claude exits after the first response
      try {
        proc.stdin.write(initMsg + '\n')
        proc.stdin.end()
      } catch {}
    })
  }

  router.get('/api/claude/slash-commands', async (req, res) => {
    const forceRefresh = req.query.refresh === '1'
    const now = Date.now()

    // Return cached result if fresh and no force-refresh
    if (!forceRefresh && _slashCommandsCache && (now - _slashCommandsCache.ts) < TTL_SLASH_MS) {
      return res.json({ commands: _slashCommandsCache.items, cached: true })
    }

    // If cache is stale but still exists, return stale immediately and refresh in background
    if (!forceRefresh && _slashCommandsCache) {
      res.json({ commands: _slashCommandsCache.items, cached: true, stale: true })
      _fetchSlashCommandsFromClaude().then((items) => {
        if (items) _slashCommandsCache = { items, ts: Date.now() }
      })
      return
    }

    // Cache cold (first call) or force refresh: await the fetch but with a 5s cap
    // so the UI isn't blocked. Return fallback if it takes too long.
    const raceResult = await Promise.race([
      _fetchSlashCommandsFromClaude(),
      new Promise((r) => setTimeout(() => r(null), 5000)),
    ])

    if (raceResult) {
      _slashCommandsCache = { items: raceResult, ts: Date.now() }
      return res.json({ commands: raceResult, cached: false })
    }

    // Fetch timed out or failed — return fallback
    return res.json({ commands: _slashCommandsCache?.items ?? SLASH_FALLBACK, cached: false, fallback: true })
  })

  // ── GET /api/claude/init-snapshot ────────────────────────────────────────────
  //
  // Spawn claude once and capture the full init event to expose model, tools,
  // plugins, skills, agents, and slash_commands to the settings panel.
  // Cached for 1 hour (same TTL as slash-commands). Returns:
  //   { model, tools[], plugins[], skills[], agents[], slash_commands[], cached }
  //
  let _initSnapshotCache = null  // { data: {...}, ts: number }
  let _initSnapshotInFlight = false
  const TTL_INIT_MS = 60 * 60 * 1000  // 1 hour

  function _fetchInitSnapshot() {
    return new Promise((resolve) => {
      if (_initSnapshotInFlight) { resolve(null); return }
      _initSnapshotInFlight = true

      const initMsg = JSON.stringify({
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: 'OK' }] },
      })

      let proc
      try {
        proc = spawn('claude', [
          '--print',
          '--output-format=stream-json',
          '--input-format=stream-json',
          '--verbose',
          '--dangerously-skip-permissions',
        ], {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env },
          cwd: home,
        })
      } catch (err) {
        console.warn('[init-snapshot] failed to spawn claude:', err.message)
        _initSnapshotInFlight = false
        resolve(null)
        return
      }

      let buf = ''
      let done = false
      const TIMEOUT = 15_000

      const timer = setTimeout(() => {
        if (!done) {
          done = true
          _initSnapshotInFlight = false
          try { proc.kill('SIGTERM') } catch {}
          console.warn('[init-snapshot] timed out waiting for claude init event')
          resolve(null)
        }
      }, TIMEOUT)

      proc.stdout.on('data', (chunk) => {
        if (done) return
        buf += chunk.toString()
        const lines = buf.split('\n')
        buf = lines.pop()
        for (const line of lines) {
          if (!line.trim()) continue
          let obj
          try { obj = JSON.parse(line) } catch { continue }
          if (obj.type === 'system' && obj.subtype === 'init') {
            done = true
            clearTimeout(timer)
            _initSnapshotInFlight = false
            try { proc.kill('SIGTERM') } catch {}
            const data = {
              model: obj.model || null,
              tools: Array.isArray(obj.tools) ? obj.tools : [],
              plugins: Array.isArray(obj.plugins) ? obj.plugins : [],
              skills: Array.isArray(obj.skills) ? obj.skills : [],
              agents: Array.isArray(obj.agents) ? obj.agents : [],
              slash_commands: Array.isArray(obj.slash_commands) ? obj.slash_commands : [],
              fast_mode_state: obj.fast_mode_state ?? null,
            }
            console.log(`[init-snapshot] fetched model=${data.model} tools=${data.tools.length}`)
            resolve(data)
          }
        }
      })

      proc.on('error', (err) => {
        if (!done) {
          done = true
          clearTimeout(timer)
          _initSnapshotInFlight = false
          console.warn('[init-snapshot] claude spawn error:', err.message)
          resolve(null)
        }
      })

      proc.on('close', () => {
        if (!done) {
          done = true
          clearTimeout(timer)
          _initSnapshotInFlight = false
          resolve(null)
        }
      })

      try {
        proc.stdin.write(initMsg + '\n')
        proc.stdin.end()
      } catch {}
    })
  }

  router.get('/api/claude/init-snapshot', async (req, res) => {
    const forceRefresh = req.query.refresh === '1'
    const now = Date.now()

    if (!forceRefresh && _initSnapshotCache && (now - _initSnapshotCache.ts) < TTL_INIT_MS) {
      return res.json({ ...(_initSnapshotCache.data), cached: true })
    }

    if (!forceRefresh && _initSnapshotCache) {
      res.json({ ...(_initSnapshotCache.data), cached: true, stale: true })
      _fetchInitSnapshot().then((data) => {
        if (data) _initSnapshotCache = { data, ts: Date.now() }
      })
      return
    }

    const result = await Promise.race([
      _fetchInitSnapshot(),
      new Promise((r) => setTimeout(() => r(null), 8000)),
    ])

    if (result) {
      _initSnapshotCache = { data: result, ts: Date.now() }
      return res.json({ ...result, cached: false })
    }

    return res.json({ model: null, tools: [], plugins: [], skills: [], agents: [], slash_commands: [], cached: false, fallback: true })
  })

  // ── GET /api/codex/config ─────────────────────────────────────────────────
  //
  // Read ~/.codex/config.toml and return the configured model value.
  // Response: { model: string|null }
  // The model field is null when the file doesn't exist or contains no model key.
  //
  router.get('/api/codex/config', (req, res) => {
    const configPath = join(home, '.codex', 'config.toml')
    let model = null
    try {
      if (existsSync(configPath)) {
        const content = readFileSync(configPath, 'utf8')
        // Parse the top-level model = "..." line (before any [section] headers)
        const match = content.match(/^model\s*=\s*"([^"]+)"/m)
        if (match) model = match[1]
      }
    } catch (err) {
      console.warn('[codex/config] failed to read config.toml:', err.message)
    }
    res.json({ model })
  })

  // ── GET /api/recent-agents ────────────────────────────────────────────────
  //
  // Scan ~/.claude/projects/*/*.jsonl by mtime descending.
  // Rule: include all files with mtime within the last 24 h; if the result is
  // fewer than 5 entries, pad up to the 5 most-recent files regardless of age.
  // Returns up to max 50 entries (no pagination needed at current scale).
  //
  // Each entry:
  //   { projectDir, projectName, cwd, sessionId, mtime (ISO), relTime, summary, active }
  //
  // cwd is read directly from the jsonl file (any row that has a 'cwd' field).
  // projectName is the basename of the real cwd (no ambiguous '-' replacement).
  // Fallback: if no cwd field found in jsonl, fall back to dir-name heuristic and log.
  //
  // Perf: cache results for 10 seconds to avoid re-reading all jsonl files on
  // every drawer open (scanning 38+ files totalling 100+ MB takes ~300ms).
  router.get('/api/recent-agents', (req, res) => {
    res.json(recentAgents.getRecentAgentsCached())
  })
  // ── Pending queue persistence ─────────────────────────────────────────────
  //
  // GET  /api/projects/:id/tabs/:tabId/queue  → { queue: string[] }
  // PUT  /api/projects/:id/tabs/:tabId/queue  body: { queue: string[] } → { queue: string[] }
  //
  // The client-side _pendingQueue is persisted here so it survives page
  // refreshes and device switches. Queue is attached to the tab record and
  // saved to data/nanocode.json on every write.

  router.get('/api/projects/:id/tabs/:tabId/queue', (req, res) => {
    const project = store.getProject(req.params.id)
    if (!project) return res.status(404).json({ error: 'project not found' })
    const tab = store.getTab ? store.getTab(req.params.id, req.params.tabId) : null
    if (!tab) return res.status(404).json({ error: 'tab not found' })
    res.json({ queue: Array.isArray(tab.pendingQueue) ? tab.pendingQueue : [] })
  })

  router.put('/api/projects/:id/tabs/:tabId/queue', (req, res) => {
    const project = store.getProject(req.params.id)
    if (!project) return res.status(404).json({ error: 'project not found' })
    const tab = store.getTab ? store.getTab(req.params.id, req.params.tabId) : null
    if (!tab) return res.status(404).json({ error: 'tab not found' })
    const rawQueue = req.body?.queue
    if (!Array.isArray(rawQueue)) {
      return res.status(400).json({ error: 'queue must be an array' })
    }
    // Sanitise: keep only non-empty strings, cap at 100 items
    const queue = rawQueue
      .filter((item) => typeof item === 'string' && item.trim().length > 0)
      .slice(0, 100)
    const updated = store.updateTabMetadata
      ? store.updateTabMetadata(req.params.id, req.params.tabId, { pendingQueue: queue })
      : null
    if (!updated) return res.status(404).json({ error: 'update failed' })
    res.json({ queue: Array.isArray(updated.pendingQueue) ? updated.pendingQueue : [] })
  })

  router.post('/api/projects/:id/tabs/:tabId/interrupt', (req, res) => {
    sessionController.handleInterrupt(req, res)
  })

  router.post('/api/projects/:id/tabs/:tabId/reset', (req, res) => {
    sessionController.handleReset(req, res)
  })

  return { router, handleTerminalWs: sessionController.handleTerminalWs, handleTabsWs }
}
