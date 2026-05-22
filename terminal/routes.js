/** Terminal routes — Express Router + WebSocket handler. */

import { Router } from 'express'
import { execFile } from 'node:child_process'
import { platform } from 'node:os'
import { readdirSync, readFileSync, existsSync } from 'node:fs'
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

  router.post('/api/projects/:id/tabs', (req, res) => {
    const project = store.getProject(req.params.id)
    if (!project) return res.status(404).json({ error: 'project not found' })
    const label = typeof req.body?.label === 'string' && req.body.label.trim()
      ? req.body.label.trim().slice(0, 40)
      : undefined
    const tab = store.createTab(req.params.id, { label })
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

  // Folder browser for the Add-project dialog. Scope is `~`, NOT a project root.
  router.get('/api/fs', (req, res) => {
    const raw = req.query.path
    const base = raw && String(raw).trim() ? resolve(home, String(raw)) : home
    const rel = relative(home, base)
    if (rel.startsWith('..') || isAbsolute(rel)) {
      return res.status(400).json({ error: 'path must be under home directory' })
    }

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
      res.status(500).json({ error: err.message })
    }
  })

  const IS_WIN = platform() === 'win32'
  const SHELL = IS_WIN
    ? (process.env.COMSPEC || 'C:\\Windows\\System32\\cmd.exe')
    : 'bash'
  const SSH = IS_WIN ? 'C:\\Windows\\System32\\OpenSSH\\ssh.exe' : 'ssh'

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

      const sessionKey = `${projectId}:bash:${tabId}`
      const isRemote = !!project.ssh_host
      let command
      let args
      let cwd

      if (isRemote) {
        command = SSH
        args = buildSshArgs(project, `cd ${sq(project.cwd)} && exec bash -l`)
        cwd = home
      } else {
        command = SHELL
        args = IS_WIN ? [] : ['--login']
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
