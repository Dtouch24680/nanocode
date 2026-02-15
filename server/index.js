/**
 * Unified server entry point.
 *
 * Single Express app on one port, serving:
 * - Codebuilder task orchestration (REST + WebSocket at /ws)
 * - Terminal PTY sessions (REST + WebSocket at /ws/terminal)
 * - Unified frontend from public/
 * - xterm vendor assets from node_modules
 */

import express from 'express'
import compression from 'compression'
import { createServer } from 'http'
import { fileURLToPath } from 'url'
import path from 'path'
import { WebSocketServer } from 'ws'
import { getStore } from './store.js'
import { createScheduler } from './scheduler.js'
import { createTerminalRoutes } from '../terminal/routes.js'
import {
  CreateTaskSchema,
  UpdateTaskSchema,
  ConfirmPlanSchema,
  RevisePlanSchema,
  WsClientMessageSchema,
} from './validation.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(__dirname, '..')
const PORT = process.env.PORT || 3000

const app = express()
app.use(compression({ threshold: 0 }))
app.use(express.json())
app.use(express.static(path.join(root, 'public')))

// Vendor routes — serve xterm packages from node_modules with long cache
const vendorOpts = { maxAge: '365d', immutable: true }
const vendorMap = {
  '/vendor/xterm': path.join(root, 'node_modules/@xterm/xterm'),
  '/vendor/xterm-addon-fit': path.join(root, 'node_modules/@xterm/addon-fit'),
  '/vendor/xterm-addon-webgl': path.join(root, 'node_modules/@xterm/addon-webgl'),
  '/vendor/xterm-addon-web-links': path.join(root, 'node_modules/@xterm/addon-web-links'),
}
for (const [route, dir] of Object.entries(vendorMap)) {
  app.use(route, express.static(dir, vendorOpts))
}

// --- Store + project migration ---

const store = getStore()

// Migrate projects from terminal/projects.json -> SQLite (one-time)
store.migrateProjectsJson(path.join(root, 'terminal', 'projects.json'))
store.ensureStarterProject()

// --- Terminal routes (projects, sessions, slack, fs) ---

const { router: terminalRouter, handleTerminalWs } = createTerminalRoutes(store)
app.use(terminalRouter)

// --- Worker pool + scheduler ---

const workers = new Map()
const clients = new Set()

function broadcast(msg) {
  const data = JSON.stringify(msg)
  for (const ws of clients) {
    if (ws.readyState === 1) ws.send(data)
  }
}

const scheduler = createScheduler(store, workers, broadcast)

function schedulerTick() {
  scheduler.tick()
}

// --- REST: Task Routes ---

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok' })
})

app.get('/api/tasks', (req, res) => {
  const projectId = req.query.projectId
  if (projectId) {
    res.json(store.listTasksByProject(projectId))
  } else {
    res.json(store.listTasks())
  }
})

app.post('/api/tasks', (req, res) => {
  const result = CreateTaskSchema.safeParse(req.body)
  if (!result.success) {
    return res.status(400).json({ error: result.error.flatten() })
  }
  const { projectId, ...data } = result.data
  if (!data.cwd && projectId) {
    const project = store.getProject(projectId)
    if (!project) return res.status(400).json({ error: 'Project not found' })
    data.cwd = project.cwd
  }
  if (!data.cwd) return res.status(400).json({ error: 'cwd or projectId required' })

  const task = store.createTask({ ...data, projectId })
  broadcast({ type: 'task:updated', task })
  schedulerTick()
  res.status(201).json(task)
})

app.get('/api/tasks/:id', (req, res) => {
  const task = store.getTask(req.params.id)
  if (!task) return res.status(404).json({ error: 'Task not found' })
  res.json(task)
})

app.patch('/api/tasks/:id', (req, res) => {
  const task = store.getTask(req.params.id)
  if (!task) return res.status(404).json({ error: 'Task not found' })

  const result = UpdateTaskSchema.safeParse(req.body)
  if (!result.success) {
    return res.status(400).json({ error: result.error.flatten() })
  }

  const fields = result.data

  if (fields.status === 'cancelled' && task.status === 'running') {
    const worker = workers.get(task.id)
    if (worker) worker.abort()
  }

  if (fields.status === 'pending' && task.status !== 'failed') {
    return res.status(400).json({ error: 'Can only retry failed tasks' })
  }

  const updated = store.updateTask(task.id, fields)
  broadcast({ type: 'task:updated', task: updated })
  if (fields.status === 'pending') schedulerTick()
  res.json(updated)
})

app.post('/api/tasks/:id/confirm', (req, res) => {
  const task = store.getTask(req.params.id)
  if (!task) return res.status(404).json({ error: 'Task not found' })
  if (task.status !== 'review') {
    return res.status(400).json({ error: 'Can only confirm tasks in review status' })
  }

  const result = ConfirmPlanSchema.safeParse(req.body)
  if (!result.success) {
    return res.status(400).json({ error: result.error.flatten() })
  }

  store.updateTask(task.id, { status: 'done', ended_at: Date.now() })
  const doneTask = store.getTask(task.id)
  broadcast({ type: 'task:updated', task: doneTask })

  const execTask = store.createTask({
    title: result.data.title || task.title,
    type: 'task',
    cwd: task.cwd,
    projectId: task.project_id || null,
  })
  store.updateTask(execTask.id, { feedback: task.plan_result })
  const finalExecTask = store.getTask(execTask.id)

  broadcast({ type: 'task:updated', task: finalExecTask })
  schedulerTick()
  res.status(201).json(finalExecTask)
})

app.post('/api/tasks/:id/revise', (req, res) => {
  const task = store.getTask(req.params.id)
  if (!task) return res.status(404).json({ error: 'Task not found' })
  if (task.status !== 'review') {
    return res.status(400).json({ error: 'Can only revise tasks in review status' })
  }

  const result = RevisePlanSchema.safeParse(req.body)
  if (!result.success) {
    return res.status(400).json({ error: result.error.flatten() })
  }

  const updated = store.updateTask(task.id, {
    status: 'pending',
    feedback: result.data.feedback,
  })
  broadcast({ type: 'task:updated', task: updated })
  schedulerTick()
  res.json(updated)
})

app.get('/api/tasks/:id/events', (req, res) => {
  const task = store.getTask(req.params.id)
  if (!task) return res.status(404).json({ error: 'Task not found' })
  const afterId = parseInt(req.query.after) || 0
  res.json(store.getEvents(task.id, afterId))
})

// --- HTTP Server ---

const server = createServer(app)

// --- WebSocket: two servers, path-routed ---

const codebuilderWss = new WebSocketServer({ noServer: true })

const deflateOpts = {
  zlibDeflateOptions: { level: 1 },
  zlibInflateOptions: { chunkSize: 16 * 1024 },
  threshold: 128,
}
const terminalWss = new WebSocketServer({ noServer: true, perMessageDeflate: deflateOpts })

server.on('upgrade', (req, socket, head) => {
  const { pathname } = new URL(req.url, `http://${req.headers.host}`)
  if (pathname === '/ws/terminal') {
    terminalWss.handleUpgrade(req, socket, head, (ws) => {
      terminalWss.emit('connection', ws, req)
    })
  } else if (pathname === '/ws') {
    codebuilderWss.handleUpgrade(req, socket, head, (ws) => {
      codebuilderWss.emit('connection', ws, req)
    })
  } else {
    socket.destroy()
  }
})

codebuilderWss.on('connection', (ws) => {
  clients.add(ws)
  ws.on('close', () => clients.delete(ws))
  ws.on('message', (raw) => {
    let msg
    try { msg = WsClientMessageSchema.parse(JSON.parse(raw)) } catch { return }
    if (msg.type === 'approve') {
      const worker = workers.get(msg.taskId)
      if (worker) worker.handleApproval(msg.eventId, msg.allow)
    }
  })
})

terminalWss.on('connection', (ws) => {
  handleTerminalWs(ws)
})

// --- Start ---

scheduler.start()

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Codebuilder running on http://0.0.0.0:${PORT}`)
})

export { app, server, store, workers, broadcast, schedulerTick }
