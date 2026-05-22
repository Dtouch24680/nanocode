/**
 * Per-user worker process.
 *
 * Owns the user's:
 *   - data file ($HOME/.nanocode/data.json)
 *   - bash PTYs
 *   - file API
 *   - tab broadcast subscribers (router-scoped, but the worker also
 *     broadcasts to its own clients via the existing ws path)
 *
 * Launched by the setuid helper or by the in-process bridge for
 * single-user mode. Reads:
 *   $HOME                       — user's home (data file location)
 *   $USER                       — username
 *   $NANOCODE_WORKER_SOCK       — Unix socket path to listen on
 *   $NANOCODE_ROUTER_SOCK       — control socket to register against
 *   $NANOCODE_TEST_FAKE_UID     — (test-only) override getuid()
 *   $NANOCODE_TEST_FAKE_USERNAME
 *
 * On boot:
 *   1. Listen on $NANOCODE_WORKER_SOCK (HTTP + WS server).
 *   2. Connect to $NANOCODE_ROUTER_SOCK; send register.
 *   3. Send claim:request; print the code to stdout.
 *   4. Stay alive serving HTTP + WS until SIGTERM.
 */

import express from 'express'
import { createServer } from 'node:http'
import { connect as netConnect } from 'node:net'
import { existsSync, mkdirSync, unlinkSync, chmodSync, writeFileSync, readFileSync } from 'node:fs'
import { WebSocketServer } from 'ws'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { DataStore } from './data-store.js'
import { createTerminalRoutes } from '../terminal/routes.js'
import { createFileRoutes } from '../terminal/files.js'
import { createFramer, encodeFrame } from '../server/ipc/protocol.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..')

const UID = Number(process.env.NANOCODE_TEST_FAKE_UID) || process.getuid()
const USERNAME = process.env.NANOCODE_TEST_FAKE_USERNAME || process.env.USER || `u${UID}`
const HOME = process.env.HOME || `/tmp/nanocode-test-${UID}`

// The setuid helper drops the caller's env. Read sock paths from a
// user-owned init file the CLI placed under $HOME/.nanocode/run/env.
function readEnvFile() {
  const envPath = path.join(HOME, '.nanocode', 'run', 'env')
  try {
    const lines = readFileSync(envPath, 'utf-8').split('\n')
    const out = {}
    for (const line of lines) {
      const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line)
      if (m) out[m[1]] = m[2]
    }
    return out
  } catch { return {} }
}
const envFile = readEnvFile()
const WORKER_SOCK = process.env.NANOCODE_WORKER_SOCK || envFile.NANOCODE_WORKER_SOCK
const ROUTER_SOCK = process.env.NANOCODE_ROUTER_SOCK || envFile.NANOCODE_ROUTER_SOCK

if (!WORKER_SOCK) {
  console.error('worker: NANOCODE_WORKER_SOCK is required')
  process.exit(2)
}

const dataDir = path.join(HOME, '.nanocode')
const dataPath = path.join(dataDir, 'data.json')
if (!existsSync(dataDir)) {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 })
}

// Build a store with the same shape the routes expect.
const store = createStoreAdapter(new DataStore({ path: dataPath }))

// Mount existing routes on a fresh express app.
const app = express()
app.use(express.json({ limit: '4mb' }))
// Static workspace assets (only reachable after the router has authed)
app.use(express.static(path.join(ROOT, 'public')))
const vendorOpts = { maxAge: '365d', immutable: true }
const vendorMap = {
  '/vendor/xterm': path.join(ROOT, 'node_modules/@xterm/xterm'),
  '/vendor/xterm-addon-fit': path.join(ROOT, 'node_modules/@xterm/addon-fit'),
  '/vendor/xterm-addon-web-links': path.join(ROOT, 'node_modules/@xterm/addon-web-links'),
  '/vendor/marked': path.join(ROOT, 'node_modules/marked/lib'),
  '/vendor/dompurify': path.join(ROOT, 'node_modules/dompurify/dist'),
}
for (const [route, dir] of Object.entries(vendorMap)) {
  app.use(route, express.static(dir, vendorOpts))
}

const { router: terminalRouter, handleTerminalWs, handleTabsWs } = createTerminalRoutes(store)
app.use(terminalRouter)
app.use(createFileRoutes(store))

const server = createServer(app)

// WS: one server per path, like the single-user mode.
const terminalWss = new WebSocketServer({ noServer: true })
const tabsWss = new WebSocketServer({ noServer: true })

server.on('upgrade', (req, socket, head) => {
  const { pathname } = new URL(req.url, `http://${req.headers.host || 'worker'}`)
  if (pathname === '/ws/terminal') {
    terminalWss.handleUpgrade(req, socket, head, (ws) => terminalWss.emit('connection', ws, req))
  } else if (pathname === '/ws/tabs') {
    tabsWss.handleUpgrade(req, socket, head, (ws) => tabsWss.emit('connection', ws, req))
  } else {
    socket.destroy()
  }
})

terminalWss.on('connection', handleTerminalWs)
tabsWss.on('connection', handleTabsWs)

// Listen on Unix socket. Remove any stale file first.
if (existsSync(WORKER_SOCK)) {
  try { unlinkSync(WORKER_SOCK) } catch {}
}
const sockDir = path.dirname(WORKER_SOCK)
if (!existsSync(sockDir)) mkdirSync(sockDir, { recursive: true, mode: 0o700 })

server.listen(WORKER_SOCK, () => {
  // The setuid helper created the parent dir with the SGID bit so the
  // socket inherits group `nanocode`. We chmod 0660 (user+group rw) so
  // the router (running as `nanocode`) can connect. Other users have
  // no traverse access to the parent dir (mode 02750), so they can't
  // reach this socket regardless of its own mode.
  try { chmodSync(WORKER_SOCK, 0o660) } catch {}
  console.log(`[worker ${USERNAME}/${UID}] listening on ${WORKER_SOCK}`)
  if (ROUTER_SOCK) connectToRouter()
})

let controlConn = null
let reconnectAttempts = 0
let reconnectTimer = null
let initialClaimRequested = false

function connectToRouter() {
  clearTimeout(reconnectTimer)
  const c = netConnect(ROUTER_SOCK)
  controlConn = c
  const framer = createFramer()
  c.on('error', (err) => {
    // Suppress noisy log on routine reconnect attempts.
    if (reconnectAttempts === 0) {
      console.error(`[worker ${USERNAME}] router connect error:`, err.message)
    }
  })
  c.on('close', () => {
    controlConn = null
    // Auto-reconnect with capped exponential backoff. The worker stays
    // alive even when the router is down, so PTYs keep running across
    // `systemctl restart nanocode`.
    const delay = Math.min(30_000, 500 * 2 ** Math.min(reconnectAttempts, 6))
    reconnectAttempts++
    reconnectTimer = setTimeout(connectToRouter, delay)
  })
  c.on('connect', () => {
    reconnectAttempts = 0
    c.write(encodeFrame({ type: 'register', uid: UID, username: USERNAME, sock: WORKER_SOCK }))
  })
  c.on('data', (chunk) => {
    framer.feed(chunk, (msg) => {
      if (msg.type === 'register:ok') {
        // Only mint a claim code on the first successful registration —
        // later reconnects (e.g., after a router restart) should NOT
        // confuse the user with a fresh code; their existing sessions
        // are still valid (persisted on the router's disk).
        if (!initialClaimRequested) {
          initialClaimRequested = true
          c.write(encodeFrame({ type: 'claim:request' }))
        }
      } else if (msg.type === 'register:err') {
        console.error(`[worker ${USERNAME}] router rejected register:`, msg.reason)
      } else if (msg.type === 'claim:code') {
        console.log(`\nEnter this code in the nanocode login page:\n\n    ${msg.code}\n\n(valid for ~60 seconds)\n`)
        try {
          const claimDir = path.join(HOME, '.nanocode', 'run')
          mkdirSync(claimDir, { recursive: true, mode: 0o700 })
          writeFileSync(path.join(claimDir, 'last-claim'), msg.code, { mode: 0o600 })
        } catch {}
      }
    })
  })
}

// SIGUSR1: the CLI ran `nanocode login` while we're already running.
// Ask the router to mint a fresh claim code (the file at
// $HOME/.nanocode/run/last-claim is then updated on next claim:code).
process.on('SIGUSR1', () => {
  if (controlConn && !controlConn.destroyed) {
    try { controlConn.write(encodeFrame({ type: 'claim:request' })) } catch {}
  } else if (ROUTER_SOCK) {
    connectToRouter()
  }
})

// Graceful shutdown. We force-close active connections so the test
// fixture's await-exit doesn't stall on a router keepalive.
function shutdown() {
  console.log(`[worker ${USERNAME}] shutting down`)
  try { unlinkSync(WORKER_SOCK) } catch {}
  if (controlConn && !controlConn.destroyed) {
    try { controlConn.destroy() } catch {}
  }
  try { server.closeAllConnections() } catch {}
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 1000).unref()
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

// Adapter: the existing terminal/files routes expect a `store` object with
// the methods of server/store.js — projects, tabs, settings, etc. Map the
// DataStore (one JSON file per user) to that interface.
const TAB_TYPES = new Set(['bash', 'claude', 'codex', 'agent', 'opencode'])

function createStoreAdapter(dataStore) {
  function load() { return dataStore.load() }
  return {
    getSetting(key) {
      return load().settings?.[key] ?? null
    },
    setSetting(key, value) {
      const data = load()
      data.settings[key] = value
      dataStore.saveSettings(data.settings)
    },
    getAllSettings() {
      return { ...load().settings }
    },
    createProject(name, cwd, existingId, ssh = {}) {
      const data = load()
      const id = existingId || cryptoRandomId()
      const project = {
        id, name, cwd,
        created_at: Date.now(),
        ssh_host: ssh.host || null,
        ssh_user: ssh.user || null,
        ssh_port: ssh.port || null,
        ssh_key: ssh.key || null,
      }
      data.projects.push(project)
      dataStore.saveProjects(data.projects)
      return { ...project }
    },
    getProject(id) {
      const p = load().projects.find((p) => p.id === id)
      return p ? { ...p } : undefined
    },
    listProjects() {
      return load().projects.map((p) => ({ ...p }))
    },
    removeProject(id) {
      const data = load()
      data.projects = data.projects.filter((p) => p.id !== id)
      delete data.tabs[id]
      dataStore.saveAll(data)
    },
    migrateProjectsJson() { /* per-user no-op */ },
    ensureStarterProject() {
      const data = load()
      if (data.projects.length === 0) {
        this.createProject(USERNAME, HOME)
      }
    },
    listTabs(projectId) {
      return (load().tabs?.[projectId] || []).map((t) => ({ ...t, type: t.type || 'bash' }))
    },
    getTab(projectId, tabId) {
      const t = (load().tabs?.[projectId] || []).find((t) => t.id === tabId)
      return t ? { ...t, type: t.type || 'bash' } : null
    },
    createTab(projectId, opts = {}) {
      const data = load()
      if (!data.tabs[projectId]) data.tabs[projectId] = []
      const id = opts.id || cryptoRandomId().slice(0, 8)
      const type = TAB_TYPES.has(opts.type) ? opts.type : 'bash'
      const n = data.tabs[projectId].filter((t) => (t.type || 'bash') === type).length + 1
      const tab = {
        id,
        label: opts.label || `${type} ${n}`,
        type,
        createdAt: Date.now(),
      }
      data.tabs[projectId].push(tab)
      dataStore.saveTabs(projectId, data.tabs[projectId])
      return { ...tab }
    },
    removeTab(projectId, tabId) {
      const data = load()
      if (!data.tabs[projectId]) return false
      const before = data.tabs[projectId].length
      data.tabs[projectId] = data.tabs[projectId].filter((t) => t.id !== tabId)
      if (data.tabs[projectId].length < before) {
        dataStore.saveTabs(projectId, data.tabs[projectId])
        return true
      }
      return false
    },
    renameTab(projectId, tabId, label) {
      const data = load()
      const tab = (data.tabs[projectId] || []).find((t) => t.id === tabId)
      if (!tab) return null
      tab.label = label
      dataStore.saveTabs(projectId, data.tabs[projectId])
      return { ...tab }
    },
    hasTab(projectId, tabId) {
      return (load().tabs?.[projectId] || []).some((t) => t.id === tabId)
    },
    close() { dataStore.close() },
  }
}

function cryptoRandomId() {
  return Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('')
}

// Pre-seed: ensure at least one project exists for new users.
store.ensureStarterProject()
