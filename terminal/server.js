/**
 * Standalone terminal server — backward-compatible entry on port 4000.
 *
 * Thin wrapper: imports the shared store and terminal routes,
 * serves the unified frontend from public/, handles WebSocket at /ws/terminal.
 *
 * This exists so that port 4000 continues to work for clients that
 * bookmarked or depend on it. The primary entry point is server/index.js (:3000).
 */

import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import express from 'express'
import compression from 'compression'
import { WebSocketServer } from 'ws'
import { getStore } from '../server/store.js'
import { createTerminalRoutes } from './routes.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')
const PORT = process.env.PORT || 4000

const app = express()
app.use(compression({ threshold: 0 }))
app.use(express.json())

// Serve the original terminal frontend
app.use(express.static(join(__dirname, 'public')))

// Vendor routes for xterm
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

// Shared store (same SQLite DB as main server)
const store = getStore()
store.migrateProjectsJson(join(root, 'terminal', 'projects.json'))
store.ensureStarterProject()

// Terminal routes (projects, sessions, slack, fs)
const { router: terminalRouter, handleTerminalWs } = createTerminalRoutes(store)
app.use(terminalRouter)

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

wss.on('connection', (ws) => {
  handleTerminalWs(ws)
})

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Terminal server listening on http://0.0.0.0:${PORT}`)
})
