/**
 * Terminal routes — Express Router + WebSocket handler.
 * Extracted from terminal/server.js for mounting in both the unified
 * server (:3000) and the standalone terminal server (:4000).
 */

import { Router } from 'express'
import { readdirSync, readFileSync, existsSync, openSync, readSync, closeSync, unlinkSync } from 'node:fs'
import { join, resolve, relative, isAbsolute } from 'node:path'
import { homedir } from 'node:os'
import * as sessions from './sessions.js'
import * as slack from './slack.js'

/**
 * Create terminal routes backed by the given store.
 *
 * @param {object} store — must expose listProjects, getProject, createProject, removeProject
 * @returns {{ router: Router, handleTerminalWs: (ws: import('ws').WebSocket) => void }}
 */
export function createTerminalRoutes(store) {
  const router = Router()
  let newSessionCounter = 0

  // --- REST: projects ---

  router.get('/api/projects', (_req, res) => {
    res.json(store.listProjects())
  })

  router.post('/api/projects', (req, res) => {
    const { name, cwd } = req.body || {}
    if (!name || !cwd) {
      return res.status(400).json({ error: 'name and cwd required' })
    }
    const project = store.createProject(name, cwd)
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

  // --- REST: running CLI sessions (PTY keys) ---

  router.get('/api/projects/:id/sessions', (req, res) => {
    const project = store.getProject(req.params.id)
    if (!project) {
      return res.status(404).json({ error: 'project not found' })
    }
    res.json(sessions.listCliSessions(req.params.id))
  })

  // --- REST: all claude sessions from disk (resumable) ---

  router.get('/api/projects/:id/claude-sessions', (req, res) => {
    const project = store.getProject(req.params.id)
    if (!project) {
      return res.status(404).json({ error: 'project not found' })
    }

    const cwd = project.cwd.replace(/\/+$/, '')
    const encoded = cwd.replace(/\//g, '-')
    const claudeDir = join(homedir(), '.claude', 'projects', encoded)

    const result = []

    if (!existsSync(claudeDir)) {
      return res.json(result)
    }

    const historyMap = new Map()
    const historyPath = join(homedir(), '.claude', 'history.jsonl')
    if (existsSync(historyPath)) {
      try {
        const lines = readFileSync(historyPath, 'utf-8').split('\n')
        for (const line of lines) {
          if (!line.trim()) continue
          try {
            const entry = JSON.parse(line)
            if (entry.project === cwd && entry.sessionId) {
              const existing = historyMap.get(entry.sessionId)
              if (!existing || entry.timestamp > existing.timestamp) {
                historyMap.set(entry.sessionId, {
                  display: entry.display || '',
                  timestamp: entry.timestamp,
                })
              }
            }
          } catch { /* skip malformed lines */ }
        }
      } catch { /* ignore read errors */ }
    }

    let files
    try {
      files = readdirSync(claudeDir).filter(f => f.endsWith('.jsonl'))
    } catch {
      return res.json(result)
    }

    for (const file of files) {
      const sessionId = file.replace('.jsonl', '')
      let slug = ''
      let timestamp = 0
      let hasUserMessage = false

      try {
        const fd = openSync(join(claudeDir, file), 'r')
        const buf = Buffer.alloc(32768)
        const bytesRead = readSync(fd, buf, 0, 32768, 0)
        closeSync(fd)
        const content = buf.toString('utf-8', 0, bytesRead)
        const lines = content.split('\n').slice(0, 25)
        for (const line of lines) {
          if (!line.trim()) continue
          try {
            const entry = JSON.parse(line)
            if (entry.slug && !slug) slug = entry.slug
            if (entry.type === 'user' && !entry.isMeta) hasUserMessage = true
            if (entry.timestamp) {
              const ts = typeof entry.timestamp === 'string'
                ? new Date(entry.timestamp).getTime()
                : entry.timestamp
              if (ts > timestamp) timestamp = ts
            }
          } catch { /* skip */ }
        }
      } catch { /* skip unreadable files */ }

      if (!hasUserMessage) {
        try { unlinkSync(join(claudeDir, file)) } catch { /* ignore */ }
        continue
      }

      const hist = historyMap.get(sessionId)
      const preview = hist?.display || ''
      const lastActivity = hist?.timestamp || timestamp || 0
      result.push({ sessionId, slug, preview, lastActivity })
    }

    result.sort((a, b) => b.lastActivity - a.lastActivity)

    // Filter out archived sessions
    const archivedIds = new Set(store.listArchivedSessions(req.params.id))
    let filtered = archivedIds.size > 0
      ? result.filter(s => !archivedIds.has(s.sessionId))
      : result

    // Filter to managed-only if requested
    if (req.query.managed === '1') {
      const managedIds = new Set(store.listManagedSessions(req.params.id))
      const runningIds = new Set(sessions.listCliSessions(req.params.id))
      filtered = filtered.filter(s => managedIds.has(s.sessionId) || runningIds.has(s.sessionId))
    }

    res.json(filtered)
  })

  // --- REST: archived sessions ---

  router.get('/api/projects/:id/archived-sessions', (req, res) => {
    const project = store.getProject(req.params.id)
    if (!project) {
      return res.status(404).json({ error: 'project not found' })
    }

    const archivedIds = new Set(store.listArchivedSessions(req.params.id))
    if (archivedIds.size === 0) return res.json([])

    const cwd = project.cwd.replace(/\/+$/, '')
    const encoded = cwd.replace(/\//g, '-')
    const claudeDir = join(homedir(), '.claude', 'projects', encoded)

    if (!existsSync(claudeDir)) return res.json([])

    const historyMap = new Map()
    const historyPath = join(homedir(), '.claude', 'history.jsonl')
    if (existsSync(historyPath)) {
      try {
        const lines = readFileSync(historyPath, 'utf-8').split('\n')
        for (const line of lines) {
          if (!line.trim()) continue
          try {
            const entry = JSON.parse(line)
            if (entry.project === cwd && entry.sessionId) {
              const existing = historyMap.get(entry.sessionId)
              if (!existing || entry.timestamp > existing.timestamp) {
                historyMap.set(entry.sessionId, {
                  display: entry.display || '',
                  timestamp: entry.timestamp,
                })
              }
            }
          } catch { /* skip malformed lines */ }
        }
      } catch { /* ignore read errors */ }
    }

    const result = []
    let files
    try {
      files = readdirSync(claudeDir).filter(f => f.endsWith('.jsonl'))
    } catch {
      return res.json(result)
    }

    for (const file of files) {
      const sessionId = file.replace('.jsonl', '')
      if (!archivedIds.has(sessionId)) continue

      let slug = ''
      let timestamp = 0

      try {
        const fd = openSync(join(claudeDir, file), 'r')
        const buf = Buffer.alloc(32768)
        const bytesRead = readSync(fd, buf, 0, 32768, 0)
        closeSync(fd)
        const content = buf.toString('utf-8', 0, bytesRead)
        const lines = content.split('\n').slice(0, 25)
        for (const line of lines) {
          if (!line.trim()) continue
          try {
            const entry = JSON.parse(line)
            if (entry.slug && !slug) slug = entry.slug
            if (entry.timestamp) {
              const ts = typeof entry.timestamp === 'string'
                ? new Date(entry.timestamp).getTime()
                : entry.timestamp
              if (ts > timestamp) timestamp = ts
            }
          } catch { /* skip */ }
        }
      } catch { /* skip unreadable files */ }

      const hist = historyMap.get(sessionId)
      const preview = hist?.display || ''
      const lastActivity = hist?.timestamp || timestamp || 0
      result.push({ sessionId, slug, preview, lastActivity })
    }

    result.sort((a, b) => b.lastActivity - a.lastActivity)
    res.json(result)
  })

  router.post('/api/projects/:id/sessions/:sessionId/archive', (req, res) => {
    const project = store.getProject(req.params.id)
    if (!project) {
      return res.status(404).json({ error: 'project not found' })
    }
    store.archiveSession(req.params.id, req.params.sessionId)
    // Kill any running PTY for this session
    sessions.destroySession(`${req.params.id}:claude:${req.params.sessionId}`)
    sessions.destroySession(`${req.params.id}:agent:${req.params.sessionId}`)
    res.status(204).send()
  })

  router.post('/api/projects/:id/sessions/:sessionId/managed', (req, res) => {
    store.markSessionManaged(req.params.id, req.params.sessionId)
    res.status(204).send()
  })

  router.delete('/api/projects/:id/sessions/:sessionId/archive', (req, res) => {
    const project = store.getProject(req.params.id)
    if (!project) {
      return res.status(404).json({ error: 'project not found' })
    }
    store.unarchiveSession(req.params.id, req.params.sessionId)
    res.status(204).send()
  })

  router.delete('/api/projects/:id/sessions/:sessionId', (req, res) => {
    const project = store.getProject(req.params.id)
    if (!project) {
      return res.status(404).json({ error: 'project not found' })
    }
    // Try all CLI providers since frontend may not know which one started the session
    const destroyed = sessions.destroySession(`${req.params.id}:claude:${req.params.sessionId}`)
      || sessions.destroySession(`${req.params.id}:agent:${req.params.sessionId}`)
    res.status(204).send()
  })

  // --- REST: Slack webhook settings ---

  router.get('/api/slack', (_req, res) => {
    res.json({ webhookUrl: slack.getWebhookUrl() })
  })

  router.put('/api/slack', (req, res) => {
    const { webhookUrl } = req.body || {}
    slack.setWebhookUrl(webhookUrl || '')
    res.json({ ok: true })
  })

  router.post('/api/slack/test', async (_req, res) => {
    if (!slack.getWebhookUrl()) {
      return res.status(400).json({ error: 'No webhook URL configured' })
    }
    await slack.notify('Test notification from Codebuilder')
    res.json({ ok: true })
  })

  // --- REST: directory listing for folder picker ---

  const home = homedir()
  router.get('/api/fs', (req, res) => {
    const raw = req.query.path
    const base = raw && String(raw).trim() ? resolve(home, String(raw)) : home
    const rel = relative(home, base)
    if (rel.startsWith('..') || isAbsolute(rel)) {
      return res.status(400).json({ error: 'path must be under home directory' })
    }
    try {
      const entries = readdirSync(base, { withFileTypes: true })
        .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
        .map((d) => ({ name: d.name, isDir: true }))
      res.json({ path: base, entries })
    } catch (err) {
      if (err.code === 'ENOENT') return res.status(404).json({ error: 'not found' })
      if (err.code === 'ENOTDIR') return res.status(400).json({ error: 'not a directory' })
      res.status(500).json({ error: err.message })
    }
  })

  // --- WebSocket handler ---

  // CLI provider configurations
  const CLI_PROVIDERS = {
    claude: {
      bin: 'claude',
      newArgs: '--dangerously-skip-permissions',
      resumeArgs: (id) => `--dangerously-skip-permissions --resume ${id}`,
    },
    agent: {
      bin: 'agent',
      newArgs: '',
      resumeArgs: (id) => `--resume ${id}`,
    },
  }

  function handleTerminalWs(ws) {
    const once = (raw) => {
      let msg
      try { msg = JSON.parse(raw) } catch { return }
      if (msg.type !== 'attach') return
      const { projectId, sessionType, cols, rows } = msg
      const claudeSessionId = msg.claudeSessionId || ''
      const cliProvider = (msg.cliProvider && CLI_PROVIDERS[msg.cliProvider]) ? msg.cliProvider : 'claude'
      if (!projectId || !sessionType) return
      if (sessionType !== 'bash' && sessionType !== 'claude') return

      const project = store.getProject(projectId)
      if (!project) {
        ws.send(JSON.stringify({ type: 'error', error: 'project not found' }))
        return
      }

      let sessionKey, command, args
      if (sessionType === 'bash') {
        sessionKey = `${projectId}:bash`
        command = 'bash'
        args = ['--login']
      } else {
        const cli = CLI_PROVIDERS[cliProvider]
        const isNew = !claudeSessionId || claudeSessionId.startsWith('new-')
        sessionKey = `${projectId}:${cliProvider}:${claudeSessionId || ('new-' + newSessionCounter++)}`
        command = 'bash'
        const cliCmd = isNew
          ? `${cli.bin}${cli.newArgs ? ' ' + cli.newArgs : ''}`
          : `${cli.bin}${cli.resumeArgs(claudeSessionId) ? ' ' + cli.resumeArgs(claudeSessionId) : ''}`
        args = ['-lc', cliCmd]
        // Track resumed sessions as managed by Codebuilder
        if (!isNew) {
          try { store.markSessionManaged(projectId, claudeSessionId) } catch { /* ignore */ }
        }
      }

      const session = sessions.getOrCreate(
        sessionKey, command, args,
        Math.max(1, cols || 80), Math.max(1, rows || 24),
        project.cwd
      )
      session.attach(ws, Math.max(1, cols || 80), Math.max(1, rows || 24))
    }
    ws.once('message', once)
  }

  return { router, handleTerminalWs }
}
