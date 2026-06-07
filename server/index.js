import express from 'express'
import compression from 'compression'
import { createServer } from 'http'
import { createConnection } from 'net'
import { fileURLToPath } from 'url'
import path from 'path'
import os from 'os'
import { readFileSync, writeFileSync } from 'fs'
import { execFile, execSync } from 'child_process'
import { promisify } from 'util'
const execFileAsync = promisify(execFile)
import { WebSocketServer } from 'ws'
import { getStore } from './store.js'
import { createTerminalRoutes } from '../terminal/routes.js'
import { createFileRoutes } from '../terminal/files.js'
import { startQaWatcher, setNtfyStore, pushNtfyTurnComplete } from './qa-watcher.js'

// ── Cache busting version string ─────────────────────────────────────────────
// Computed once at startup: short git SHA or fallback timestamp.
// Every HTML asset reference (?v=xxx) uses this so iOS Safari cache
// invalidates automatically after each server restart (new deploy).
let ASSET_VERSION = String(Date.now())
try {
  ASSET_VERSION = execSync('git rev-parse --short HEAD', { encoding: 'utf8', timeout: 3000 }).trim()
} catch { /* non-git env — use timestamp */ }

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(__dirname, '..')
const PORT = process.env.PORT || 3000
const HOST = process.env.HOST || '0.0.0.0'

// System mode: this process becomes the router. Workers are spawned
// per-user by `nanocode login` (via the setuid helper) and reach us via
// the control socket. See docs/system-mode-design.md.
if (process.env.NANOCODE_SYSTEM === '1') {
  const { startRouterMode } = await import('./router-mode.js')
  startRouterMode({ host: HOST, port: Number(PORT) })
  // Skip single-user setup below — the import above defines its own server.
} else {
  await startSingleUserMode()
}

async function startSingleUserMode() {

const app = express()
// gzip on every response
app.use(compression())
app.use(express.json())

// ── P4: Cache busting — serve index.html with ?v= version strings injected ──
// iOS Safari aggressively caches static assets. We serve index.html via a
// dynamic route so we can inject the asset version string into CSS/JS URLs.
// All other public files use Cache-Control: no-store to prevent stale caches.
const _indexHtmlPath = path.join(root, 'public', 'index.html')
let _indexHtmlTemplate = ''
try { _indexHtmlTemplate = readFileSync(_indexHtmlPath, 'utf8') } catch {}

function getVersionedIndexHtml() {
  // Inject ?v=<sha> into style.css and app.js / tts.js references
  return _indexHtmlTemplate
    .replace(/(href="\/style\.css)(")/g, `$1?v=${ASSET_VERSION}$2`)
    .replace(/(src="\/js\/([^"?]+\.js))(")/g, `$1?v=${ASSET_VERSION}$3`)
}

app.get('/', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.send(getVersionedIndexHtml())
})

// Dev-mode: no-store for all /js/* and /style.css so browser never caches JS/CSS
app.use((req, res, next) => {
  const url = req.path
  if (url === '/style.css' || url.startsWith('/js/') || url === '/manifest.json') {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate')
  }
  next()
})

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
setNtfyStore(store)

const { router: terminalRouter, handleTerminalWs, handleTabsWs } = createTerminalRoutes(store)

// ─── Token auth middleware ─────────────────────────────────────────────────
// Setting: nanocode_auth_token (string). Default '' = auth disabled.
// When non-empty, all /api/* requests must supply a matching token via:
//   - Header:      X-Nanocode-Token: <token>
//   - Query param: ?token=<token>
// WebSocket upgrades are also checked via the ?token= query param.
// /api/health is intentionally exempt so monitors can check liveness.

function getAuthToken() {
  return store.getSetting('nanocode_auth_token') || ''
}

function checkApiToken(req, res, next) {
  const expected = getAuthToken()
  if (!expected) return next()  // auth disabled
  const provided = req.headers['x-nanocode-token'] || req.query.token || ''
  if (provided !== expected) {
    return res.status(401).json({ error: 'Unauthorized: invalid or missing token' })
  }
  next()
}

// Apply token check to all /api/* except /api/health
app.use('/api', (req, res, next) => {
  if (req.path === '/health') return next()
  checkApiToken(req, res, next)
})

app.use(terminalRouter)
app.use(createFileRoutes(store))

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok' })
})

// ─── Version endpoint — used by the browser to detect server restarts ─────────
// Returns the same ASSET_VERSION computed at startup (git SHA or timestamp).
// The browser records this on page load and polls / checks on WS reconnect;
// when the version changes it knows the server was updated and shows a banner.
app.get('/api/version', (_req, res) => {
  res.json({ version: ASSET_VERSION })
})

// ─── Turn-complete ntfy push ──────────────────────────────────────────────────
// Front-end calls this after detecting elapsed > threshold.
// Backend does the actual ntfy push so the API key / URL stays server-side.

app.post('/api/notify/turn-complete', (req, res) => {
  const { elapsed, elapsedSec } = req.body || {}
  const sec = elapsedSec ?? (elapsed != null ? (elapsed / 1000).toFixed(0) : '?')
  pushNtfyTurnComplete({ elapsedSec: sec })
  res.json({ ok: true })
})

// ─── Settings ─────────────────────────────────────────────────────────────

const VALID_CLI_PROVIDERS = new Set(['claude', 'agent', 'opencode', 'codex'])

app.get('/api/settings', (_req, res) => {
  res.json(store.getAllSettings())
})

app.put('/api/settings', (req, res) => {
  const { key, value } = req.body || {}
  if (!key || value === undefined) {
    return res.status(400).json({ error: 'key and value required' })
  }
  if (key === 'cli_provider' && !VALID_CLI_PROVIDERS.has(value)) {
    return res.status(400).json({ error: `Invalid cli_provider: ${value}` })
  }
  store.setSetting(key, value)
  res.json({ ok: true })
})

// ─── Auth status (P1-4) ────────────────────────────────────────────────────

let _authStatusCache = null
let _authStatusCacheAt = 0
const AUTH_CACHE_MS = 60_000  // 60 seconds

app.get('/api/auth/status', async (_req, res) => {
  const now = Date.now()
  if (_authStatusCache && now - _authStatusCacheAt < AUTH_CACHE_MS) {
    return res.json(_authStatusCache)
  }
  try {
    const result = await new Promise((resolve, reject) => {
      execFile('claude', ['auth', 'status', '--json'], { timeout: 5000 }, (err, stdout, stderr) => {
        if (err) {
          // Return a graceful not-logged-in response if claude auth status fails
          resolve({ loggedIn: false, error: err.message })
        } else {
          try {
            resolve(JSON.parse(stdout.trim()))
          } catch {
            resolve({ loggedIn: false, error: 'parse error', raw: stdout.slice(0, 200) })
          }
        }
      })
    })
    _authStatusCache = result
    _authStatusCacheAt = now
    res.json(result)
  } catch (err) {
    res.status(500).json({ loggedIn: false, error: err.message })
  }
})

// ─── TTS proxy — forwards text to a local GPT-SoVITS v3 service ──────────

const TTS_BASE = process.env.TTS_URL || 'http://127.0.0.1:9880'

function getTtsConfig() {
  const s = store.getAllSettings()
  return {
    ref_audio_path: s.tts_ref_audio || '/storage/home/zhiningjiao/code/GPT-SoVITS/ref_audio.wav',
    prompt_text: s.tts_prompt_text || '这是猫娘秘书的声音喵，主人你好呀',
    prompt_lang: s.tts_prompt_lang || 'zh',
    text_lang: s.tts_text_lang || 'en',
    media_type: s.tts_media_type || 'ogg',
  }
}

// Serial queue for GPT-SoVITS (single-threaded inference, no concurrency)
let ttsQueueTail = Promise.resolve()
function ttsSerialize(fn) {
  const p = ttsQueueTail.then(fn, fn)
  ttsQueueTail = p.catch(() => {})
  return p
}

// Non-streaming TTS — POST /tts, returns full audio (with retry)
app.post('/api/tts', (req, res) => {
  const { text } = req.body || {}
  if (!text) return res.status(400).json({ error: 'text required' })
  ttsSerialize(() => handleTts(req, res))
})

async function handleTts(req, res) {
  const { text } = req.body || {}
  const cfg = getTtsConfig()
  const payload = {
    text,
    text_lang: cfg.text_lang,
    ref_audio_path: cfg.ref_audio_path,
    prompt_text: cfg.prompt_text,
    prompt_lang: cfg.prompt_lang,
    media_type: cfg.media_type,
    streaming_mode: false,
  }
  const maxRetries = 2
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const ttsRes = await fetch(`${TTS_BASE}/tts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(60000),
      })
      if (!ttsRes.ok) {
        const detail = await ttsRes.text().catch(() => '')
        console.warn(`[TTS] attempt ${attempt}: service returned ${ttsRes.status}`, detail.slice(0, 200))
        if (attempt < maxRetries) continue
        return res.status(502).json({ error: `TTS service returned ${ttsRes.status}`, detail: detail.slice(0, 200) })
      }
      res.set('Content-Type', ttsRes.headers.get('content-type') || `audio/${cfg.media_type}`)
      const arrayBuf = await ttsRes.arrayBuffer()
      res.send(Buffer.from(arrayBuf))
      return
    } catch (err) {
      console.warn(`[TTS] attempt ${attempt}: ${err.message}`)
      if (attempt < maxRetries) continue
      res.status(503).json({ error: 'TTS service unavailable', detail: err.message })
    }
  }
}

// Streaming TTS — proxies chunked audio from GPT-SoVITS GET /tts endpoint
app.get('/api/tts/stream', async (req, res) => {
  const { text } = req.query
  if (!text) return res.status(400).json({ error: 'text required' })
  const cfg = getTtsConfig()
  const params = new URLSearchParams({
    text,
    text_lang: cfg.text_lang,
    ref_audio_path: cfg.ref_audio_path,
    prompt_text: cfg.prompt_text,
    prompt_lang: cfg.prompt_lang,
    media_type: cfg.media_type,
    streaming_mode: 'true',
  })
  try {
    const ttsRes = await fetch(`${TTS_BASE}/tts?${params}`)
    if (!ttsRes.ok) {
      return res.status(502).json({ error: `TTS service returned ${ttsRes.status}` })
    }
    res.set('Content-Type', ttsRes.headers.get('content-type') || `audio/${cfg.media_type}`)
    res.set('Transfer-Encoding', 'chunked')
    const reader = ttsRes.body.getReader()
    const pump = async () => {
      while (true) {
        const { done, value } = await reader.read()
        if (done) { res.end(); return }
        if (!res.write(value)) {
          await new Promise(resolve => res.once('drain', resolve))
        }
      }
    }
    pump().catch(() => res.end())
    req.on('close', () => reader.cancel())
  } catch (err) {
    res.status(503).json({ error: 'TTS service unavailable', detail: err.message })
  }
})

// Voice reference configuration
app.post('/api/tts/voice', async (req, res) => {
  const { ref_audio_path, prompt_text, prompt_lang } = req.body || {}
  if (!ref_audio_path) return res.status(400).json({ error: 'ref_audio_path required' })
  try {
    const params = new URLSearchParams({ refer_audio_path: ref_audio_path })
    const r = await fetch(`${TTS_BASE}/set_refer_audio?${params}`)
    if (!r.ok) return res.status(502).json({ error: `set_refer_audio returned ${r.status}` })
    store.setSetting('tts_ref_audio', ref_audio_path)
    if (prompt_text) store.setSetting('tts_prompt_text', prompt_text)
    if (prompt_lang) store.setSetting('tts_prompt_lang', prompt_lang)
    res.json({ ok: true })
  } catch (err) {
    res.status(503).json({ error: 'TTS service unavailable', detail: err.message })
  }
})

app.get('/api/tts/status', async (_req, res) => {
  try {
    const r = await fetch(`${TTS_BASE}/tts`, { signal: AbortSignal.timeout(2000) })
    res.json({ available: true, config: getTtsConfig() })
  } catch {
    res.json({ available: false, config: getTtsConfig() })
  }
})

// ─── Service port health checker ─────────────────────────────────────────────

const SERVICES_CONFIG_PATH = path.join(__dirname, 'services-config.json')
const DEFAULT_SERVICES = [
  { name: 'mblend',      host: '10.18.8.55', port: 5050 },
  { name: 'dccpipeline', host: '10.18.8.55', port: 8765 },
  { name: 'regression',  host: '10.18.8.55', port: 8000 },
  { name: 'nanocode',    host: 'localhost',  port: 3001 },
  { name: 'TTS',         host: 'localhost',  port: 9880 },
]

let watchedServices = DEFAULT_SERVICES
try { watchedServices = JSON.parse(readFileSync(SERVICES_CONFIG_PATH, 'utf8')) } catch {}

const SERVICE_CHECK_MS = 30_000
const serviceStatus = {}
for (const s of watchedServices) serviceStatus[s.name] = { status: 'unknown', checkedAt: null }

// ─── Agent manager ───────────────────────────────────────────────────────────

const AGENTS_CONFIG_PATH = path.join(__dirname, 'agents-config.json')
let agentsConfig = []
try { agentsConfig = JSON.parse(readFileSync(AGENTS_CONFIG_PATH, 'utf8')) } catch {}

async function checkTmuxWindow(target) {
  if (!target) return 'unknown'
  try { await execFileAsync('tmux', ['has-session', '-t', target], { timeout: 2000 }); return 'running' }
  catch { return 'stopped' }
}

// ─────────────────────────────────────────────────────────────────────────────

function getLocalIPs() {
  const ips = []
  for (const iface of Object.values(os.networkInterfaces())) {
    for (const addr of iface) {
      if (!addr.internal && addr.family === 'IPv4') ips.push(addr.address)
    }
  }
  return ips
}

function checkPort(host, port) {
  return new Promise((resolve) => {
    const sock = createConnection({ host, port }, () => { sock.destroy(); resolve(true) })
    sock.setTimeout(2000)
    sock.on('timeout', () => { sock.destroy(); resolve(false) })
    sock.on('error', () => resolve(false))
  })
}

async function runServiceChecks(broadcast) {
  for (const svc of watchedServices) {
    const prev = serviceStatus[svc.name]?.status
    const up = await checkPort(svc.host, svc.port)
    const status = up ? 'up' : 'down'
    const checkedAt = new Date().toISOString()
    serviceStatus[svc.name] = { status, checkedAt }
    if (prev !== 'unknown' && prev !== status) {
      console.warn(`[health] ${svc.name}:${svc.port} ${prev} → ${status}`)
      broadcast({ type: 'service_status', name: svc.name, status, checkedAt })
    }
  }
}

app.get('/api/services', (_req, res) => {
  res.json(serviceStatus)
})

app.get('/api/services-config', (_req, res) => {
  res.json({ services: watchedServices, localIPs: getLocalIPs() })
})

app.get('/api/agents', async (_req, res) => {
  const agents = await Promise.all(agentsConfig.map(async a => ({
    ...a,
    status: await checkTmuxWindow(a.tmuxWindow),
  })))
  res.json(agents)
})

app.put('/api/agents', (req, res) => {
  const agents = req.body
  if (!Array.isArray(agents)) return res.status(400).json({ error: 'expected array' })
  agentsConfig = agents
  try { writeFileSync(AGENTS_CONFIG_PATH, JSON.stringify(agents, null, 2)) } catch {}
  res.json({ ok: true })
})

// 【保留·暂隐藏】Discovered = 扫描 tmux 窗口发现外部 agent。当前工作流已全在 nanocode 内，面板入口隐藏以保持清爽；功能代码保留，以后做"监控 subagent"(自动发现并监控 tmux agent)会用到。
app.get('/api/agents/discover', async (_req, res) => {
  try {
    const { stdout } = await execFileAsync(
      'tmux', ['list-windows', '-a', '-F', '#{session_name}:#{window_name}\t#{pane_current_command}'],
      { timeout: 5000 }
    )
    const windows = stdout.trim().split('\n').filter(Boolean).map(line => {
      const [target, cmd] = line.split('\t')
      const name = target.split(':').slice(1).join(':') || target
      const lc = (name + ' ' + (cmd || '')).toLowerCase()
      let type = 'other'
      if (lc.includes('claude')) type = 'claude'
      else if (lc.includes('codex')) type = 'codex'
      else if (lc.includes('cursor')) type = 'cursor'
      return { name, type, tmuxWindow: target, cmd: cmd || '' }
    })
    res.json(windows)
  } catch { res.json([]) }
})

app.put('/api/services-config', (req, res) => {
  const { services } = req.body
  if (!Array.isArray(services)) return res.status(400).json({ error: 'services must be array' })
  for (const s of services) {
    if (!s.name || !s.host || !Number.isInteger(s.port) || s.port < 1 || s.port > 65535) {
      return res.status(400).json({ error: `invalid entry: ${JSON.stringify(s)}` })
    }
  }
  watchedServices = services
  for (const s of services) {
    if (!serviceStatus[s.name]) serviceStatus[s.name] = { status: 'unknown', checkedAt: null }
  }
  for (const name of Object.keys(serviceStatus)) {
    if (!services.find(s => s.name === name)) delete serviceStatus[name]
  }
  try { writeFileSync(SERVICES_CONFIG_PATH, JSON.stringify(services, null, 2)) } catch (e) {
    console.error('[services-config] write failed:', e)
  }
  res.json({ ok: true })
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
const notifyWss = new WebSocketServer({ noServer: true })

server.on('upgrade', (req, socket, head) => {
  const parsed = new URL(req.url, `http://${req.headers.host}`)
  const { pathname, searchParams } = parsed

  // WebSocket token auth: if auth is enabled, check ?token= query param
  const expectedWsToken = getAuthToken()
  if (expectedWsToken) {
    const provided = searchParams.get('token') || req.headers['x-nanocode-token'] || ''
    if (provided !== expectedWsToken) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nContent-Type: text/plain\r\n\r\nUnauthorized')
      socket.destroy()
      return
    }
  }

  if (pathname === '/ws/terminal') {
    terminalWss.handleUpgrade(req, socket, head, (ws) => {
      terminalWss.emit('connection', ws, req)
    })
  } else if (pathname === '/ws/tabs') {
    tabsWss.handleUpgrade(req, socket, head, (ws) => {
      tabsWss.emit('connection', ws, req)
    })
  } else if (pathname === '/ws/notify') {
    notifyWss.handleUpgrade(req, socket, head, (ws) => {
      notifyWss.emit('connection', ws, req)
    })
  } else {
    socket.destroy()
  }
})

terminalWss.on('connection', (ws) => handleTerminalWs(ws))
tabsWss.on('connection', (ws) => handleTabsWs(ws))
notifyWss.on('connection', (ws) => {
  ws.on('error', () => {})
  // Push server version immediately on every (re)connect so the browser can
  // detect whether the server was restarted while the page was open.
  if (ws.readyState === 1) {
    try { ws.send(JSON.stringify({ type: 'server_version', version: ASSET_VERSION })) } catch {}
  } else {
    ws.once('open', () => {
      try { ws.send(JSON.stringify({ type: 'server_version', version: ASSET_VERSION })) } catch {}
    })
  }
})

function broadcastNotify(msg) {
  const data = JSON.stringify(msg)
  for (const ws of notifyWss.clients) {
    if (ws.readyState === 1) ws.send(data)
  }
}

startQaWatcher(broadcastNotify)

// Run initial check after startup, then every 30s
setTimeout(() => runServiceChecks(broadcastNotify), 5000)
setInterval(() => runServiceChecks(broadcastNotify), SERVICE_CHECK_MS)

server.listen(PORT, HOST, () => {
  console.log(`Nanocode running on http://${HOST}:${PORT}`)
})

} // end startSingleUserMode
