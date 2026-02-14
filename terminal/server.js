import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve, relative, isAbsolute } from 'node:path'
import { readdirSync, readFileSync, existsSync, openSync, readSync, closeSync } from 'node:fs'
import { homedir } from 'node:os'
import express from 'express'
import compression from 'compression'
import { WebSocketServer } from 'ws'
import * as projects from './projects.js'
import * as sessions from './sessions.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')
const PORT = process.env.PORT || 4000

const app = express()

app.use(compression({ threshold: 0 }))
app.use(express.json())

// Static files
app.use(express.static(join(__dirname, 'public')))

// Vendor routes — serve xterm packages from node_modules with 1-year cache
const vendorOpts = { maxAge: '365d', immutable: true }
const vendorMap = {
  '/vendor/xterm': join(root, 'node_modules/@xterm/xterm'),
  '/vendor/xterm-addon-fit': join(root, 'node_modules/@xterm/addon-fit'),
  '/vendor/xterm-addon-webgl': join(root, 'node_modules/@xterm/addon-webgl'),
  '/vendor/xterm-addon-web-links': join(root, 'node_modules/@xterm/addon-web-links'),
}
for (const [route, dir] of Object.entries(vendorMap)) {
  app.use(route, express.static(dir, vendorOpts))
}

// REST: projects
app.get('/api/projects', (req, res) => {
  res.json(projects.list())
})

app.post('/api/projects', (req, res) => {
  const { name, cwd } = req.body || {}
  if (!name || !cwd) {
    return res.status(400).json({ error: 'name and cwd required' })
  }
  const project = projects.create(name, cwd)
  res.status(201).json(project)
})

app.delete('/api/projects/:id', (req, res) => {
  const project = projects.get(req.params.id)
  if (!project) {
    return res.status(404).json({ error: 'project not found' })
  }
  sessions.destroySessions(req.params.id)
  projects.remove(req.params.id)
  res.status(204).send()
})

// REST: running claude sessions (PTY keys)
app.get('/api/projects/:id/sessions', (req, res) => {
  const project = projects.get(req.params.id)
  if (!project) {
    return res.status(404).json({ error: 'project not found' })
  }
  res.json(sessions.listClaudeSessions(req.params.id))
})

// REST: all claude sessions from disk (resumable)
app.get('/api/projects/:id/claude-sessions', (req, res) => {
  const project = projects.get(req.params.id)
  if (!project) {
    return res.status(404).json({ error: 'project not found' })
  }

  const cwd = project.cwd.replace(/\/+$/, '') // strip trailing slash
  // Encode path: /storage/home/syzs/codebuilder → -storage-home-syzs-codebuilder
  const encoded = cwd.replace(/\//g, '-')
  const claudeDir = join(homedir(), '.claude', 'projects', encoded)

  const result = []

  if (!existsSync(claudeDir)) {
    return res.json(result)
  }

  // Read history.jsonl for display previews and timestamps
  const historyMap = new Map() // sessionId → { display, timestamp }
  const historyPath = join(homedir(), '.claude', 'history.jsonl')
  if (existsSync(historyPath)) {
    try {
      const lines = readFileSync(historyPath, 'utf-8').split('\n')
      for (const line of lines) {
        if (!line.trim()) continue
        try {
          const entry = JSON.parse(line)
          if (entry.project === cwd && entry.sessionId) {
            // Keep the latest entry per session (history is append-only)
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

  // Scan .jsonl files in the claude project dir
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

    // Read first ~32KB to extract slug, timestamp (avoids reading multi-MB files)
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

    // Cross-reference with history for better display and timestamp
    const hist = historyMap.get(sessionId)
    const preview = hist?.display || ''
    const lastActivity = hist?.timestamp || timestamp || 0

    result.push({ sessionId, slug, preview, lastActivity })
  }

  // Sort by most recent first
  result.sort((a, b) => b.lastActivity - a.lastActivity)
  res.json(result)
})

app.delete('/api/projects/:id/sessions/:sessionId', (req, res) => {
  const project = projects.get(req.params.id)
  if (!project) {
    return res.status(404).json({ error: 'project not found' })
  }
  const sessionKey = `${req.params.id}:claude:${req.params.sessionId}`
  sessions.destroySession(sessionKey)
  res.status(204).send()
})

// List directory under home for folder picker (browse from home only)
const home = homedir()
app.get('/api/fs', (req, res) => {
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

const server = createServer(app)

const deflateOpts = {
  zlibDeflateOptions: { level: 1 },
  zlibInflateOptions: { chunkSize: 16 * 1024 },
  threshold: 128,
}
const wss = new WebSocketServer({ noServer: true, perMessageDeflate: deflateOpts })

server.on('upgrade', (req, socket, head) => {
  const { pathname } = new URL(req.url, `http://${req.headers.host}`)
  if (pathname === '/ws/terminal') {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
  } else {
    socket.destroy()
  }
})

// Counter for new (non-resume) sessions
let newSessionCounter = 0

wss.on('connection', (ws) => {
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
    if (!projectId || !sessionType) return
    if (sessionType !== 'bash' && sessionType !== 'claude') return

    const project = projects.get(projectId)
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
      // Claude session — use claudeSessionId or create a new one
      const isNew = !claudeSessionId || claudeSessionId.startsWith('new-')
      sessionKey = `${projectId}:claude:${claudeSessionId || ('new-' + newSessionCounter++)}`
      command = 'bash'
      args = isNew
        ? ['-lc', 'claude --dangerously-skip-permissions']
        : ['-lc', `claude --dangerously-skip-permissions --resume ${claudeSessionId}`]
    }

    const session = sessions.getOrCreate(
      sessionKey,
      command,
      args,
      Math.max(1, cols || 80),
      Math.max(1, rows || 24),
      project.cwd
    )
    session.attach(ws, Math.max(1, cols || 80), Math.max(1, rows || 24))
  }
  ws.once('message', once)
})

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Terminal app listening on http://0.0.0.0:${PORT}`)
})
