/**
 * Terminal routes — Express Router + WebSocket handler.
 * Mounted by the main application server.
 *
 * Architecture: docs/architecture.md#rest-api
 */

import { Router } from 'express'
import { execFileSync, execFile } from 'node:child_process'
import { platform } from 'node:os'
import {
  readdirSync,
  readFileSync,
  existsSync,
  openSync,
  readSync,
  closeSync,
  unlinkSync,
} from 'node:fs'
import { join, resolve, relative, isAbsolute } from 'node:path'
import { homedir } from 'node:os'
import * as sessions from './sessions.js'

/**
 * Create terminal routes backed by the given store.
 *
 * Architecture: docs/architecture.md#server-architecture
 */
export function createTerminalRoutes(store) {
  const router = Router()
  let newSessionCounter = 0
  const VALID_CLI_PROVIDERS = new Set(['claude', 'agent', 'opencode'])

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
        // Skip wildcard-only entries
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
    // Only return hosts that resolve to a real server (have HostName or aren't github, etc.)
    return hosts.filter((h) => h.hostname && h.hostname !== 'github.com')
  }

  function getCliProvider(rawProvider) {
    return VALID_CLI_PROVIDERS.has(rawProvider) ? rawProvider : undefined
  }

  function listClaudeSessions(projectId, cwd) {
    const encoded = cwd.replace(/\//g, '-')
    const claudeDir = join(homedir(), '.claude', 'projects', encoded)
    const result = []

    if (!existsSync(claudeDir)) return result

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
          } catch {
            /* skip malformed lines */
          }
        }
      } catch {
        /* ignore read errors */
      }
    }

    let files
    try {
      files = readdirSync(claudeDir).filter((file) => file.endsWith('.jsonl'))
    } catch {
      return result
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
              const ts =
                typeof entry.timestamp === 'string'
                  ? new Date(entry.timestamp).getTime()
                  : entry.timestamp
              if (ts > timestamp) timestamp = ts
            }
          } catch {
            /* skip */
          }
        }
      } catch {
        /* skip unreadable files */
      }

      if (!hasUserMessage) {
        try {
          unlinkSync(join(claudeDir, file))
        } catch {
          /* ignore */
        }
        continue
      }

      const hist = historyMap.get(sessionId)
      const preview = hist?.display || ''
      const lastActivity = hist?.timestamp || timestamp || 0
      result.push({ sessionId, slug, preview, lastActivity })
    }

    result.sort((a, b) => b.lastActivity - a.lastActivity)
    return result
  }

  function listOpencodeSessions(cwd) {
    try {
      const output = execFileSync('opencode', ['session', 'list', '--format', 'json'], {
        cwd,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      })
      const allSessions = JSON.parse(output)
      return allSessions
        .filter((session) => session.directory === cwd)
        .map((session) => ({
          sessionId: session.id,
          slug: session.title || '',
          preview: session.title || '',
          lastActivity: session.updated || session.created || 0,
        }))
        .sort((a, b) => b.lastActivity - a.lastActivity)
    } catch {
      return []
    }
  }

  function listProviderSessions(projectId, cwd, provider) {
    if (provider === 'opencode') return listOpencodeSessions(cwd)
    if (provider === 'claude') return listClaudeSessions(projectId, cwd)
    return []
  }

  router.get('/api/ssh-hosts', (_req, res) => {
    const configPath = join(home, '.ssh', 'config')
    if (!existsSync(configPath)) return res.json([])
    try {
      const content = readFileSync(configPath, 'utf-8')
      const hosts = parseSshConfig(content)
      res.json(hosts)
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
      if (err) {
        return res.json({ ok: false, error: err.message })
      }
      res.json({ ok: stdout.trim() === 'ok' })
    })
  })

  router.get('/api/projects/:id/sessions', (req, res) => {
    const project = store.getProject(req.params.id)
    if (!project) {
      return res.status(404).json({ error: 'project not found' })
    }
    const provider = getCliProvider(req.query.provider)
    res.json(sessions.listCliSessions(req.params.id, provider))
  })

  router.get('/api/projects/:id/claude-sessions', (req, res) => {
    const project = store.getProject(req.params.id)
    if (!project) {
      return res.status(404).json({ error: 'project not found' })
    }

    const cwd = project.cwd.replace(/\/+$/, '')
    const provider = getCliProvider(req.query.provider) || 'claude'
    const result = listProviderSessions(req.params.id, cwd, provider)

    const archivedIds = new Set(store.listArchivedSessions(req.params.id))
    let filtered =
      archivedIds.size > 0
        ? result.filter((session) => !archivedIds.has(session.sessionId))
        : result

    if (req.query.managed === '1') {
      const managedIds = new Set(store.listManagedSessions(req.params.id))
      const runningIds = new Set(sessions.listCliSessions(req.params.id, provider))
      filtered = filtered.filter(
        (session) =>
          managedIds.has(session.sessionId) || runningIds.has(session.sessionId)
      )
    }

    res.json(filtered)
  })

  router.get('/api/projects/:id/archived-sessions', (req, res) => {
    const project = store.getProject(req.params.id)
    if (!project) {
      return res.status(404).json({ error: 'project not found' })
    }

    const archivedIds = new Set(store.listArchivedSessions(req.params.id))
    if (archivedIds.size === 0) return res.json([])

    const cwd = project.cwd.replace(/\/+$/, '')
    const provider = getCliProvider(req.query.provider) || 'claude'
    const result = listProviderSessions(req.params.id, cwd, provider).filter((session) =>
      archivedIds.has(session.sessionId)
    )
    res.json(result)
  })

  router.post('/api/projects/:id/sessions/:sessionId/archive', (req, res) => {
    const project = store.getProject(req.params.id)
    if (!project) {
      return res.status(404).json({ error: 'project not found' })
    }
    store.archiveSession(req.params.id, req.params.sessionId)
    sessions.destroySession(`${req.params.id}:claude:${req.params.sessionId}`)
    sessions.destroySession(`${req.params.id}:agent:${req.params.sessionId}`)
    sessions.destroySession(`${req.params.id}:opencode:${req.params.sessionId}`)
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
    sessions.destroySession(`${req.params.id}:claude:${req.params.sessionId}`) ||
      sessions.destroySession(`${req.params.id}:agent:${req.params.sessionId}`) ||
      sessions.destroySession(`${req.params.id}:opencode:${req.params.sessionId}`)
    res.status(204).send()
  })

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
    opencode: {
      bin: 'opencode',
      newArgs: '.',
      resumeArgs: (id) => `--session ${id}`,
    },
  }

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
    // Wrap in bash -lc so the user's PATH (nvm, etc.) is available
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
      const claudeSessionId = msg.claudeSessionId || ''
      const cliProvider =
        msg.cliProvider && CLI_PROVIDERS[msg.cliProvider] ? msg.cliProvider : 'claude'
      if (!projectId || !sessionType) return
      if (sessionType !== 'bash' && sessionType !== 'claude') return

      const project = store.getProject(projectId)
      if (!project) {
        ws.send(JSON.stringify({ type: 'error', error: 'project not found' }))
        return
      }

      let sessionKey
      let command
      let args
      let cwd

      const isRemote = !!project.ssh_host

      if (sessionType === 'bash') {
        sessionKey = `${projectId}:bash`
        if (isRemote) {
          command = SSH
          args = buildSshArgs(project, `cd ${sq(project.cwd)} && exec bash -l`)
          cwd = home
        } else {
          command = SHELL
          args = IS_WIN ? [] : ['--login']
          cwd = project.cwd
        }
      } else {
        const cli = CLI_PROVIDERS[cliProvider]
        const isNew = !claudeSessionId || claudeSessionId.startsWith('new-')
        sessionKey = `${projectId}:${cliProvider}:${claudeSessionId || 'new-' + newSessionCounter++}`
        const cliCmd = isNew
          ? `${cli.bin}${cli.newArgs ? ' ' + cli.newArgs : ''}`
          : `${cli.bin}${cli.resumeArgs(claudeSessionId) ? ' ' + cli.resumeArgs(claudeSessionId) : ''}`
        if (isRemote) {
          command = SSH
          args = buildSshArgs(project, `cd ${sq(project.cwd)} && ${cliCmd}`)
          cwd = home
        } else if (IS_WIN) {
          command = SHELL
          args = ['/c', cliCmd]
          cwd = project.cwd
        } else {
          command = 'bash'
          args = ['-lc', cliCmd]
          cwd = project.cwd
        }
        if (!isNew) {
          try {
            store.markSessionManaged(projectId, claudeSessionId)
          } catch {
            /* ignore */
          }
        }
      }

      const session = sessions.getOrCreate(
        sessionKey,
        command,
        args,
        Math.max(1, cols || 80),
        Math.max(1, rows || 24),
        cwd
      )
      session.attach(ws, Math.max(1, cols || 80), Math.max(1, rows || 24))
    }

    ws.once('message', once)
  }

  return { router, handleTerminalWs }
}
