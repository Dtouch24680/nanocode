/**
 * Server entry point.
 *
 * Express app serving REST API and static files, with WebSocket
 * for real-time task event streaming.
 *
 * Architecture: server/docs/task-lifecycle.md
 */

import express from 'express'
import { createServer } from 'http'
import { fileURLToPath } from 'url'
import path from 'path'
import { WebSocketServer } from 'ws'
import { getStore } from './store.js'
import { createScheduler } from './scheduler.js'
import {
  CreateTaskSchema,
  UpdateTaskSchema,
  ConfirmPlanSchema,
  RevisePlanSchema,
  WsClientMessageSchema,
} from './validation.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PORT = process.env.PORT || 3000

const app = express()
app.use(express.json())
app.use(express.static(path.join(__dirname, '..', 'public')))

const store = getStore()

// --- Worker pool + scheduler ---
const workers = new Map()

/** Set of connected WebSocket clients. */
const clients = new Set()

/**
 * Broadcast a JSON message to all connected WebSocket clients.
 *
 * Architecture: server/docs/worker-streaming.md#broadcast
 */
function broadcast(msg) {
  const data = JSON.stringify(msg)
  for (const ws of clients) {
    if (ws.readyState === 1) ws.send(data)
  }
}

const scheduler = createScheduler(store, workers, broadcast)

/** Trigger a scheduler tick (called after task mutations). */
function schedulerTick() {
  scheduler.tick()
}

// --- REST Routes ---

/** GET /api/health */
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok' })
})

/**
 * GET /api/tasks — list all tasks.
 * Architecture: docs/architecture.md#rest-task-crud
 */
app.get('/api/tasks', (_req, res) => {
  res.json(store.listTasks())
})

/**
 * POST /api/tasks — create a task.
 * Architecture: docs/architecture.md#rest-task-crud
 */
app.post('/api/tasks', (req, res) => {
  const result = CreateTaskSchema.safeParse(req.body)
  if (!result.success) {
    return res.status(400).json({ error: result.error.flatten() })
  }
  const task = store.createTask(result.data)
  broadcast({ type: 'task:updated', task })
  schedulerTick()
  res.status(201).json(task)
})

/**
 * GET /api/tasks/:id — get a single task.
 * Architecture: docs/architecture.md#rest-task-crud
 */
app.get('/api/tasks/:id', (req, res) => {
  const task = store.getTask(req.params.id)
  if (!task) return res.status(404).json({ error: 'Task not found' })
  res.json(task)
})

/**
 * PATCH /api/tasks/:id — cancel or retry a task.
 * Architecture: docs/architecture.md#rest-task-crud
 */
app.patch('/api/tasks/:id', (req, res) => {
  const task = store.getTask(req.params.id)
  if (!task) return res.status(404).json({ error: 'Task not found' })

  const result = UpdateTaskSchema.safeParse(req.body)
  if (!result.success) {
    return res.status(400).json({ error: result.error.flatten() })
  }

  const fields = result.data

  // If cancelling a running task, abort its worker
  if (fields.status === 'cancelled' && task.status === 'running') {
    const worker = workers.get(task.id)
    if (worker) worker.abort()
  }

  // If retrying a failed task, allow pending reset
  if (fields.status === 'pending' && task.status !== 'failed') {
    return res
      .status(400)
      .json({ error: 'Can only retry failed tasks' })
  }

  const updated = store.updateTask(task.id, fields)
  broadcast({ type: 'task:updated', task: updated })
  if (fields.status === 'pending') schedulerTick()
  res.json(updated)
})

/**
 * POST /api/tasks/:id/confirm — confirm a plan and spawn execution task.
 * Architecture: docs/architecture.md#rest-task-crud
 */
app.post('/api/tasks/:id/confirm', (req, res) => {
  const task = store.getTask(req.params.id)
  if (!task) return res.status(404).json({ error: 'Task not found' })
  if (task.status !== 'review') {
    return res
      .status(400)
      .json({ error: 'Can only confirm tasks in review status' })
  }

  const result = ConfirmPlanSchema.safeParse(req.body)
  if (!result.success) {
    return res.status(400).json({ error: result.error.flatten() })
  }

  // Mark plan as done
  store.updateTask(task.id, { status: 'done', ended_at: Date.now() })
  const doneTask = store.getTask(task.id)
  broadcast({ type: 'task:updated', task: doneTask })

  // Create execution task with plan as context
  const execTask = store.createTask({
    title: result.data.title || task.title,
    type: 'task',
    cwd: task.cwd,
  })
  // Store the plan result as feedback so the worker can use it as context
  store.updateTask(execTask.id, { feedback: task.plan_result })
  const finalExecTask = store.getTask(execTask.id)

  broadcast({ type: 'task:updated', task: finalExecTask })
  schedulerTick()

  res.status(201).json(finalExecTask)
})

/**
 * POST /api/tasks/:id/revise — revise a plan with feedback.
 * Architecture: docs/architecture.md#rest-task-crud
 */
app.post('/api/tasks/:id/revise', (req, res) => {
  const task = store.getTask(req.params.id)
  if (!task) return res.status(404).json({ error: 'Task not found' })
  if (task.status !== 'review') {
    return res
      .status(400)
      .json({ error: 'Can only revise tasks in review status' })
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

/**
 * GET /api/tasks/:id/events — fetch events, optionally incremental.
 * Architecture: docs/architecture.md#rest-task-crud
 */
app.get('/api/tasks/:id/events', (req, res) => {
  const task = store.getTask(req.params.id)
  if (!task) return res.status(404).json({ error: 'Task not found' })

  const afterId = parseInt(req.query.after) || 0
  res.json(store.getEvents(task.id, afterId))
})

// --- Server startup ---

const server = createServer(app)

// --- WebSocket ---

const wss = new WebSocketServer({ server })

wss.on('connection', (ws) => {
  clients.add(ws)
  ws.on('close', () => clients.delete(ws))

  ws.on('message', (raw) => {
    let msg
    try {
      msg = WsClientMessageSchema.parse(JSON.parse(raw))
    } catch {
      return // ignore malformed messages
    }

    if (msg.type === 'approve') {
      const worker = workers.get(msg.taskId)
      if (worker) worker.handleApproval(msg.eventId, msg.allow)
    }
  })
})

// --- Start scheduler + listen ---

scheduler.start()

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Codebuilder running on http://0.0.0.0:${PORT}`)
})

export { app, server, store, workers, broadcast, schedulerTick }
