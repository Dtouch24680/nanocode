import express from 'express'
import compression from 'compression'
import { createServer } from 'http'
import { fileURLToPath } from 'url'
import path from 'path'
import { WebSocketServer } from 'ws'
import { getStore } from './store.js'
import { createTerminalRoutes } from '../terminal/routes.js'
import { createFileRoutes } from '../terminal/files.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(__dirname, '..')
const PORT = Number(process.env.PORT) || 3000
const HOST = process.env.HOST || '0.0.0.0'

// System mode: this process becomes the router. Workers are spawned
// per-user by `nanocode login` (via the setuid helper) and reach us via
// the control socket. See docs/system-mode-design.md.
if (process.env.NANOCODE_SYSTEM === '1') {
  const { startRouterMode } = await import('./router-mode.js')
  startRouterMode({ host: HOST, port: PORT })
  // Skip single-user setup below — the import above defines its own server.
} else {
  await startSingleUserMode()
}

async function startSingleUserMode() {

const app = express()
// gzip on every response — see worker/index.js for the rationale.
app.use(compression())
app.use(express.json())
app.use(express.static(path.join(root, 'public')))

const vendorOpts = { maxAge: '365d', immutable: true }
const vendorMap = {
  '/vendor/xterm': path.join(root, 'node_modules/@xterm/xterm'),
  '/vendor/xterm-addon-fit': path.join(root, 'node_modules/@xterm/addon-fit'),
  '/vendor/xterm-addon-web-links': path.join(root, 'node_modules/@xterm/addon-web-links'),
  '/vendor/marked': path.join(root, 'node_modules/marked/lib'),
  '/vendor/dompurify': path.join(root, 'node_modules/dompurify/dist'),
  '/vendor/three': path.join(root, 'node_modules/three'),
}
for (const [route, dir] of Object.entries(vendorMap)) {
  app.use(route, express.static(dir, vendorOpts))
}

const store = getStore()
store.migrateProjectsJson(path.join(root, 'terminal', 'projects.json'))
store.ensureStarterProject()

const { router: terminalRouter, handleTerminalWs, handleTabsWs } = createTerminalRoutes(store)
app.use(terminalRouter)
app.use(createFileRoutes(store))

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok' })
})

const server = createServer(app)

const deflateOpts = {
  zlibDeflateOptions: { level: 1 },
  zlibInflateOptions: { chunkSize: 16 * 1024 },
  threshold: 128,
}
const terminalWss = new WebSocketServer({
  noServer: true,
  perMessageDeflate: deflateOpts,
})
const tabsWss = new WebSocketServer({ noServer: true })

server.on('upgrade', (req, socket, head) => {
  const { pathname } = new URL(req.url, `http://${req.headers.host}`)
  if (pathname === '/ws/terminal') {
    terminalWss.handleUpgrade(req, socket, head, (ws) => {
      terminalWss.emit('connection', ws, req)
    })
  } else if (pathname === '/ws/tabs') {
    tabsWss.handleUpgrade(req, socket, head, (ws) => {
      tabsWss.emit('connection', ws, req)
    })
  } else {
    socket.destroy()
  }
})

terminalWss.on('connection', (ws) => handleTerminalWs(ws))
tabsWss.on('connection', (ws) => handleTabsWs(ws))

server.listen(PORT, HOST, () => {
  console.log(`Nanocode running on http://${HOST}:${PORT}`)
})
} // end startSingleUserMode
