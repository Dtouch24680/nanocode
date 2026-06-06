import { state } from './state.js'
import { fetchProjects, fetchSettings, updateSetting } from './api.js'
import { initSidebar, renderSidebar } from './sidebar.js'
import { initAgentDrawer } from './agents.js'
import {
  initTerminalView,
  switchTerminalProject,
  fitTerminals,
  isInitialized,
} from './terminal-view.js'
import { showHosts, showProjects, hideLanding } from './landing.js'
import { slugify, hostSlug, projectSlug, projectPath, navigateTo } from './router.js'
import { initThemeToggle } from './theme.js'
import {
  getToolFoldLevel, setToolFoldLevel,
  getSubagentPromptVisible, setSubagentPromptVisible,
  getSubagentActivityVisible, setSubagentActivityVisible,
} from './claude-block-renderer.js'

let workspaceReady = false

// ─── QA notification WebSocket ────────────────────────────────────────────────

function showNotifyToast(msg, duration = 6000) {
  let el = document.getElementById('notify-toast')
  if (!el) {
    el = document.createElement('div')
    el.id = 'notify-toast'
    el.style.cssText = 'position:fixed;top:20px;right:20px;background:rgba(20,20,40,0.96);color:#f0f0f0;padding:12px 20px;border-radius:10px;font-size:13px;z-index:9999;pointer-events:none;opacity:0;transition:opacity 0.3s;backdrop-filter:blur(12px);border:1px solid rgba(100,180,255,0.3);max-width:300px;'
    document.body.appendChild(el)
  }
  el.textContent = msg
  el.style.opacity = '1'
  clearTimeout(el._timer)
  el._timer = setTimeout(() => { el.style.opacity = '0' }, duration)
}

function initNotifyWs() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
  const ws = new WebSocket(`${proto}//${location.host}/ws/notify`)
  ws.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data)
      if (msg.type === 'qa_notify') {
        const text = `[QA] ${msg.repo}: ${msg.task}${msg.summary ? ' — ' + msg.summary.slice(0, 60) : ''}`
        showNotifyToast(text)
        playNotifySound('qa')
        console.log('[notify]', text)
      } else if (msg.type === 'done_notify') {
        const text = `[DONE] ${msg.repo}: ${msg.task} (${msg.reviewer})`
        showNotifyToast(text, 8000)
        playNotifySound('done')
        console.log('[notify]', text)
      } else if (msg.type === 'blocked_notify') {
        const text = `[BLOCKED] ${msg.repo}: ${msg.task}${msg.reason ? ' — ' + msg.reason.slice(0, 80) : ''}`
        showNotifyToast(text, 10000)
        playNotifySound('blocked')
        console.log('[notify]', text)
      } else if (msg.type === 'service_status') {
        updateServiceDot(msg.name, msg.status, msg.checkedAt)
      } else if (msg.type === 'activity') {
        console.log('[activity]', msg.repo, msg.heading)
      }
    } catch {}
  }
  ws.onclose = () => setTimeout(initNotifyWs, 5000)
  ws.onerror = () => {}
}

// ─── Services health ──────────────────────────────────────────────────────────

let _servicesConfig = []

function updateServiceDot(name, status, checkedAt) {
  const dot = document.getElementById(`svc-dot-${name}`)
  if (dot) {
    dot.className = `service-dot ${status}`
    dot.title = `${name}: ${status}${checkedAt ? ' (checked ' + checkedAt.slice(11, 16) + ' UTC)' : ''}`
  }
}

function _renderServicesGrid(services, status) {
  const grid = document.getElementById('services-grid')
  if (!grid) return
  grid.innerHTML = ''
  for (const svc of services) {
    const info = status[svc.name] || { status: 'unknown' }
    const row = document.createElement('div')
    row.className = 'service-item'
    row.dataset.svc = svc.name
    row.innerHTML = `
      <span class="service-dot ${info.status}" id="svc-dot-${svc.name}" title="${svc.name}: ${info.status}"></span>
      <span class="service-name">${svc.name} <span class="service-port">${svc.host}:${svc.port}</span></span>
      <span class="service-actions">
        <button type="button" class="svc-btn svc-edit-btn" data-name="${svc.name}" title="Edit">&#9998;</button>
        <button type="button" class="svc-btn svc-del-btn" data-name="${svc.name}" title="Delete">&#10005;</button>
      </span>`
    grid.appendChild(row)
  }

  grid.querySelectorAll('.svc-del-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      _servicesConfig = _servicesConfig.filter(s => s.name !== btn.dataset.name)
      await _saveServicesConfig()
    })
  })

  grid.querySelectorAll('.svc-edit-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const name = btn.dataset.name
      const svc = _servicesConfig.find(s => s.name === name)
      if (!svc) return
      const row = btn.closest('.service-item')
      const dotStatus = (status[name] || {}).status || 'unknown'
      row.innerHTML = `
        <span class="service-dot ${dotStatus}" id="svc-dot-${name}"></span>
        <input type="text" class="settings-input svc-edit-name" value="${svc.name}" style="width:90px" />
        <input type="text" class="settings-input svc-edit-host" value="${svc.host}" style="width:120px" />
        <input type="number" class="settings-input svc-edit-port" value="${svc.port}" min="1" max="65535" style="width:60px" />
        <button type="button" class="btn btn-primary svc-save-btn" style="padding:2px 8px;font-size:12px">Save</button>
        <button type="button" class="svc-btn svc-cancel-btn">&#10005;</button>`
      row.querySelector('.svc-save-btn').addEventListener('click', async () => {
        const newName = row.querySelector('.svc-edit-name').value.trim()
        const newHost = row.querySelector('.svc-edit-host').value.trim()
        const newPort = parseInt(row.querySelector('.svc-edit-port').value, 10)
        if (!newName || !newHost || !newPort) return
        const idx = _servicesConfig.findIndex(s => s.name === name)
        if (idx >= 0) _servicesConfig[idx] = { name: newName, host: newHost, port: newPort }
        await _saveServicesConfig()
      })
      row.querySelector('.svc-cancel-btn').addEventListener('click', () => loadServices())
    })
  })
}

async function _saveServicesConfig() {
  try {
    await fetch('/api/services-config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ services: _servicesConfig }),
    })
    await loadServices()
  } catch {}
}

async function loadServices() {
  try {
    const [cfgRes, statusRes] = await Promise.all([
      fetch('/api/services-config').then(r => r.json()),
      fetch('/api/services').then(r => r.json()),
    ])
    _servicesConfig = cfgRes.services || []

    const ipEl = document.getElementById('services-local-ip')
    if (ipEl && cfgRes.localIPs?.length) ipEl.textContent = `Local: ${cfgRes.localIPs.join(', ')}`

    _renderServicesGrid(_servicesConfig, statusRes)

    let lastChecked = null
    for (const info of Object.values(statusRes)) {
      if (info.checkedAt && (!lastChecked || info.checkedAt > lastChecked)) lastChecked = info.checkedAt
    }
    const el = document.getElementById('services-checked-at')
    if (el && lastChecked) el.textContent = `Last checked: ${lastChecked.slice(0, 16).replace('T', ' ')} UTC`
  } catch {}
}

// Wire Add service form
const _svcAddForm = document.getElementById('services-add-form')
if (_svcAddForm) {
  _svcAddForm.addEventListener('submit', async (e) => {
    e.preventDefault()
    const name = document.getElementById('svc-add-name').value.trim()
    const host = document.getElementById('svc-add-host').value.trim()
    const port = parseInt(document.getElementById('svc-add-port').value, 10)
    if (!name || !host || !port) return
    _servicesConfig = [..._servicesConfig, { name, host, port }]
    await _saveServicesConfig()
    document.getElementById('svc-add-name').value = ''
    document.getElementById('svc-add-host').value = ''
    document.getElementById('svc-add-port').value = ''
  })
}

// ─── Notification Sounds ──────────────────────────────────────────────────────

const NOTIFY_SOUND_KEY = 'notifySoundPrefs'
let _notifyAudioCtx = null
const _defaultSounds = { done: 'bamboo', blocked: 'thud', qa: 'ding' }

function _getAudioCtx() {
  if (!_notifyAudioCtx) _notifyAudioCtx = new (window.AudioContext || window.webkitAudioContext)()
  if (_notifyAudioCtx.state === 'suspended') _notifyAudioCtx.resume()
  return _notifyAudioCtx
}

document.addEventListener('click', () => { try { _getAudioCtx() } catch {} }, { once: true })
document.addEventListener('touchstart', () => { try { _getAudioCtx() } catch {} }, { once: true })

function _playBamboo(vol) {
  const ctx = _getAudioCtx()
  const now = ctx.currentTime
  const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.12), ctx.sampleRate)
  const data = buf.getChannelData(0)
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1
  const src = ctx.createBufferSource()
  src.buffer = buf
  const bp = ctx.createBiquadFilter()
  bp.type = 'bandpass'; bp.frequency.value = 1400; bp.Q.value = 12
  const gain = ctx.createGain()
  gain.gain.setValueAtTime(vol, now)
  gain.gain.exponentialRampToValueAtTime(0.001, now + 0.1)
  src.connect(bp); bp.connect(gain); gain.connect(ctx.destination)
  src.start(now); src.stop(now + 0.12)
}

function _playThud(vol) {
  const ctx = _getAudioCtx()
  const now = ctx.currentTime
  const osc = ctx.createOscillator()
  osc.type = 'sine'
  osc.frequency.setValueAtTime(90, now)
  osc.frequency.exponentialRampToValueAtTime(45, now + 0.25)
  const gain = ctx.createGain()
  gain.gain.setValueAtTime(vol, now)
  gain.gain.exponentialRampToValueAtTime(0.001, now + 0.3)
  osc.connect(gain); gain.connect(ctx.destination)
  osc.start(now); osc.stop(now + 0.3)
}

function _playDing(vol) {
  const ctx = _getAudioCtx()
  const now = ctx.currentTime
  for (const [freq, decay] of [[880, 0.55], [1760, 0.35]]) {
    const osc = ctx.createOscillator()
    osc.type = 'sine'; osc.frequency.value = freq
    const gain = ctx.createGain()
    gain.gain.setValueAtTime(vol * 0.6, now)
    gain.gain.exponentialRampToValueAtTime(0.001, now + decay)
    osc.connect(gain); gain.connect(ctx.destination)
    osc.start(now); osc.stop(now + decay)
  }
}

const _soundFns = { bamboo: _playBamboo, thud: _playThud, ding: _playDing }

function getNotifySoundPrefs() {
  try { return JSON.parse(localStorage.getItem(NOTIFY_SOUND_KEY)) || {} } catch { return {} }
}

function playNotifySound(eventType) {
  const prefs = getNotifySoundPrefs()
  if (prefs.enabled === false) return
  const vol = parseFloat(prefs.volume ?? 0.7)
  const key = prefs[eventType + '_sound'] ?? _defaultSounds[eventType]
  const fn = _soundFns[key]
  if (fn) try { fn(vol) } catch {}
}

function loadNotifySoundSettings() {
  const prefs = getNotifySoundPrefs()
  const enabledEl = document.getElementById('notify-sound-enabled')
  const volEl = document.getElementById('notify-sound-volume')
  const volVal = document.getElementById('notify-sound-volume-value')
  if (enabledEl) enabledEl.checked = prefs.enabled !== false
  if (volEl) {
    volEl.value = prefs.volume ?? 0.7
    if (volVal) volVal.textContent = Math.round((prefs.volume ?? 0.7) * 100) + '%'
  }
  for (const type of ['done', 'blocked', 'qa']) {
    const sel = document.getElementById(`notify-sound-${type}`)
    if (sel) sel.value = prefs[type + '_sound'] ?? _defaultSounds[type]
  }
}

const _notifySoundVolEl = document.getElementById('notify-sound-volume')
const _notifySoundVolVal = document.getElementById('notify-sound-volume-value')
if (_notifySoundVolEl) {
  _notifySoundVolEl.addEventListener('input', () => {
    if (_notifySoundVolVal) _notifySoundVolVal.textContent = Math.round(_notifySoundVolEl.value * 100) + '%'
  })
}

const _notifySoundSaveBtn = document.getElementById('notify-sound-save-btn')
if (_notifySoundSaveBtn) {
  _notifySoundSaveBtn.addEventListener('click', () => {
    const prefs = {
      enabled: document.getElementById('notify-sound-enabled')?.checked ?? true,
      volume: parseFloat(document.getElementById('notify-sound-volume')?.value ?? 0.7),
      done_sound: document.getElementById('notify-sound-done')?.value ?? 'bamboo',
      blocked_sound: document.getElementById('notify-sound-blocked')?.value ?? 'thud',
      qa_sound: document.getElementById('notify-sound-qa')?.value ?? 'ding',
    }
    localStorage.setItem(NOTIFY_SOUND_KEY, JSON.stringify(prefs))
    const statusEl = document.getElementById('notify-sound-status')
    if (statusEl) {
      statusEl.textContent = 'Saved'
      statusEl.className = 'settings-status success'
      setTimeout(() => { statusEl.textContent = '' }, 3000)
    }
  })
}

for (const type of ['done', 'blocked', 'qa']) {
  const btn = document.getElementById(`notify-test-${type}`)
  if (btn) {
    btn.addEventListener('click', () => {
      const key = document.getElementById(`notify-sound-${type}`)?.value ?? _defaultSounds[type]
      const vol = parseFloat(document.getElementById('notify-sound-volume')?.value ?? 0.7)
      const fn = _soundFns[key]
      if (fn) try { fn(vol) } catch {}
    })
  }
}

// ─── Settings panel (CLI provider + font size + ntfy + renderMode + codexRenderMode) ──

const cliProviderGroup = document.getElementById('cli-provider-group')
const cliSaveBtn = document.getElementById('cli-save-btn')
const cliStatusEl = document.getElementById('cli-status')

const fontSizeRange = document.getElementById('font-size-range')
const fontSizeValue = document.getElementById('font-size-value')
const fontSizeSaveBtn = document.getElementById('font-size-save-btn')
const fontSizeStatusEl = document.getElementById('font-size-status')

const renderModeGroup = document.getElementById('render-mode-group')
const renderModeSaveBtn = document.getElementById('render-mode-save-btn')
const renderModeStatusEl = document.getElementById('render-mode-status')

const codexRenderModeGroup = document.getElementById('codex-render-mode-group')
const codexRenderModeSaveBtn = document.getElementById('codex-render-mode-save-btn')
const codexRenderModeStatusEl = document.getElementById('codex-render-mode-status')

// N43-R9: Codex Model selector removed — use /model command inside codex instead
// const codexModelGroup / codexModelSaveBtn / codexModelStatusEl removed

function loadRenderModeSettings(serverSettings) {
  const mode = (serverSettings?.renderMode) || 'block'
  const radios = renderModeGroup?.querySelectorAll('input[name="render-mode"]')
  if (radios) {
    for (const radio of radios) radio.checked = radio.value === mode
  }
}

function loadCodexRenderModeSettings(serverSettings) {
  // Default to 'terminal' — xterm raw is the stable default for codex
  const mode = (serverSettings?.codexRenderMode) || 'terminal'
  const radios = codexRenderModeGroup?.querySelectorAll('input[name="codex-render-mode"]')
  if (radios) {
    for (const radio of radios) radio.checked = radio.value === mode
  }
}

function loadSettings(serverSettings) {
  const radios = cliProviderGroup?.querySelectorAll('input[name="cli-provider"]')
  if (radios && state.cliProvider) {
    for (const radio of radios) {
      radio.checked = radio.value === state.cliProvider
    }
  }
  if (fontSizeRange && state.fontSize) {
    fontSizeRange.value = state.fontSize
    if (fontSizeValue) fontSizeValue.textContent = state.fontSize + 'px'
  }
  loadNotifySoundSettings()
  loadNtfySettings()
  loadToolFoldSettings()
  loadAutoResumeSettings()
  loadSubagentVisSettings()
  loadRenderModeSettings(serverSettings)
  loadCodexRenderModeSettings(serverSettings)
  // loadCodexModelSettings removed — N43-R9
  loadClaudeModelSettings(serverSettings)
  loadClaudeEffortSettings(serverSettings)
  loadPermissionModeSettings(serverSettings)
  loadClaudeDriverSettings(serverSettings)
}

if (cliSaveBtn) {
  cliSaveBtn.addEventListener('click', async () => {
    const selected = cliProviderGroup?.querySelector('input[name="cli-provider"]:checked')
    if (!selected) return
    try {
      await updateSetting('cli_provider', selected.value)
      state.cliProvider = selected.value
      if (cliStatusEl) {
        cliStatusEl.textContent = 'Saved'
        cliStatusEl.className = 'settings-status success'
        setTimeout(() => { cliStatusEl.textContent = '' }, 3000)
      }
    } catch (err) {
      if (cliStatusEl) {
        cliStatusEl.textContent = err.message
        cliStatusEl.className = 'settings-status error'
        setTimeout(() => { cliStatusEl.textContent = '' }, 3000)
      }
    }
  })
}

// ─── Render mode save ────────────────────────────────────────────────────────

if (renderModeSaveBtn) {
  renderModeSaveBtn.addEventListener('click', async () => {
    const selected = renderModeGroup?.querySelector('input[name="render-mode"]:checked')
    if (!selected) return
    const mode = selected.value === 'terminal' ? 'terminal' : 'block'
    try {
      await updateSetting('renderMode', mode)
      state.renderMode = mode
      if (renderModeStatusEl) {
        renderModeStatusEl.textContent = 'Saved — 新 tab 生效'
        renderModeStatusEl.className = 'settings-status success'
        setTimeout(() => { renderModeStatusEl.textContent = '' }, 3000)
      }
    } catch (err) {
      if (renderModeStatusEl) {
        renderModeStatusEl.textContent = err.message
        renderModeStatusEl.className = 'settings-status error'
        setTimeout(() => { renderModeStatusEl.textContent = '' }, 3000)
      }
    }
  })
}

// ─── Codex render mode save ──────────────────────────────────────────────────

if (codexRenderModeSaveBtn) {
  codexRenderModeSaveBtn.addEventListener('click', async () => {
    const selected = codexRenderModeGroup?.querySelector('input[name="codex-render-mode"]:checked')
    if (!selected) return
    const mode = selected.value === 'block' ? 'block' : 'terminal'
    try {
      await updateSetting('codexRenderMode', mode)
      state.codexRenderMode = mode
      if (codexRenderModeStatusEl) {
        codexRenderModeStatusEl.textContent = 'Saved — 新 codex tab 生效'
        codexRenderModeStatusEl.className = 'settings-status success'
        setTimeout(() => { codexRenderModeStatusEl.textContent = '' }, 3000)
      }
    } catch (err) {
      if (codexRenderModeStatusEl) {
        codexRenderModeStatusEl.textContent = err.message
        codexRenderModeStatusEl.className = 'settings-status error'
        setTimeout(() => { codexRenderModeStatusEl.textContent = '' }, 3000)
      }
    }
  })
}

// N43-R9: Codex model save handler removed — model is now set via /model command

if (fontSizeRange && fontSizeValue) {
  fontSizeRange.addEventListener('input', () => {
    fontSizeValue.textContent = fontSizeRange.value + 'px'
  })
}

if (fontSizeSaveBtn) {
  fontSizeSaveBtn.addEventListener('click', async () => {
    const size = parseInt(fontSizeRange?.value, 10)
    if (!size || size < 10 || size > 22) return
    try {
      await updateSetting('font_size', size)
      state.fontSize = size
      if (fontSizeStatusEl) {
        fontSizeStatusEl.textContent = 'Saved'
        fontSizeStatusEl.className = 'settings-status success'
        setTimeout(() => { fontSizeStatusEl.textContent = '' }, 3000)
      }
    } catch (err) {
      if (fontSizeStatusEl) {
        fontSizeStatusEl.textContent = err.message
        fontSizeStatusEl.className = 'settings-status error'
        setTimeout(() => { fontSizeStatusEl.textContent = '' }, 3000)
      }
    }
  })
}

// ─── ntfy settings ────────────────────────────────────────────────────────────

async function loadNtfySettings() {
  try {
    const s = await fetchSettings()
    const urlEl = document.getElementById('ntfy-url')
    const topicEl = document.getElementById('ntfy-topic')
    if (urlEl) urlEl.value = s.ntfy_url || ''
    if (topicEl) topicEl.value = s.ntfy_topic || ''
  } catch {}
}

const _ntfySaveBtn = document.getElementById('ntfy-save-btn')
if (_ntfySaveBtn) {
  _ntfySaveBtn.addEventListener('click', async () => {
    const url = document.getElementById('ntfy-url')?.value.trim() || ''
    const topic = document.getElementById('ntfy-topic')?.value.trim() || ''
    const statusEl = document.getElementById('ntfy-status')
    try {
      await updateSetting('ntfy_url', url)
      await updateSetting('ntfy_topic', topic)
      if (statusEl) {
        statusEl.textContent = 'Saved'
        statusEl.className = 'settings-status success'
        setTimeout(() => { statusEl.textContent = '' }, 3000)
      }
    } catch (err) {
      if (statusEl) {
        statusEl.textContent = err.message
        statusEl.className = 'settings-status error'
        setTimeout(() => { statusEl.textContent = '' }, 3000)
      }
    }
  })
}

const _ntfyTestBtn = document.getElementById('ntfy-test-btn')
if (_ntfyTestBtn) {
  _ntfyTestBtn.addEventListener('click', async () => {
    const url = document.getElementById('ntfy-url')?.value.trim() || ''
    const topic = document.getElementById('ntfy-topic')?.value.trim() || ''
    const statusEl = document.getElementById('ntfy-status')
    if (!url || !topic) {
      if (statusEl) {
        statusEl.textContent = 'Fill in URL and topic first'
        statusEl.className = 'settings-status error'
        setTimeout(() => { statusEl.textContent = '' }, 3000)
      }
      return
    }
    try {
      const endpoint = url.replace(/\/$/, '') + '/' + topic
      const resp = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Title': 'Nanocode test', 'Tags': 'tada', 'Priority': '3', 'Content-Type': 'text/plain' },
        body: 'Nanocode ntfy test notification',
      })
      if (statusEl) {
        statusEl.textContent = resp.ok ? 'Sent!' : `HTTP ${resp.status}`
        statusEl.className = resp.ok ? 'settings-status success' : 'settings-status error'
        setTimeout(() => { statusEl.textContent = '' }, 3000)
      }
    } catch (err) {
      if (statusEl) {
        statusEl.textContent = err.message
        statusEl.className = 'settings-status error'
        setTimeout(() => { statusEl.textContent = '' }, 3000)
      }
    }
  })
}

// ─── Tool fold settings ───────────────────────────────────────────────────────

const AUTORESUME_KEY = 'cbr_claude_autoresume'

function loadToolFoldSettings() {
  const current = getToolFoldLevel()
  const radios = document.querySelectorAll('input[name="tool-fold"]')
  for (const r of radios) r.checked = r.value === current
}

function loadAutoResumeSettings() {
  const el = document.getElementById('claude-autoresume-enabled')
  if (el) {
    const stored = localStorage.getItem(AUTORESUME_KEY)
    // Default true; only false if explicitly disabled
    el.checked = stored !== 'false'
  }
}

// Live apply on radio change — no Save click needed
document.querySelectorAll('input[name="tool-fold"]').forEach((radio) => {
  radio.addEventListener('change', () => {
    if (radio.checked) {
      setToolFoldLevel(radio.value)
      const statusEl = document.getElementById('tool-fold-status')
      if (statusEl) {
        statusEl.textContent = 'Saved'
        statusEl.className = 'settings-status success'
        setTimeout(() => { statusEl.textContent = '' }, 2500)
      }
    }
  })
})

// Save button still works as explicit confirmation (already persisted by change handler)
const toolFoldSaveBtn = document.getElementById('tool-fold-save-btn')
if (toolFoldSaveBtn) {
  toolFoldSaveBtn.addEventListener('click', () => {
    const radios = document.querySelectorAll('input[name="tool-fold"]')
    const selected = [...radios].find((r) => r.checked)
    const statusEl = document.getElementById('tool-fold-status')
    if (selected) {
      setToolFoldLevel(selected.value)
      if (statusEl) {
        statusEl.textContent = 'Saved'
        statusEl.className = 'settings-status success'
        setTimeout(() => { statusEl.textContent = '' }, 2500)
      }
    }
  })
}

// ─── Subagent visibility settings ────────────────────────────────────────────

function loadSubagentVisSettings() {
  const promptEl = document.getElementById('subagent-prompt-visible')
  const activityEl = document.getElementById('subagent-activity-visible')
  if (promptEl) promptEl.checked = getSubagentPromptVisible()
  if (activityEl) activityEl.checked = getSubagentActivityVisible()
}

// Live apply on checkbox change — no Save click needed
const subagentPromptEl = document.getElementById('subagent-prompt-visible')
if (subagentPromptEl) {
  subagentPromptEl.addEventListener('change', () => {
    setSubagentPromptVisible(subagentPromptEl.checked)
    const statusEl = document.getElementById('subagent-vis-status')
    if (statusEl) {
      statusEl.textContent = 'Saved'
      statusEl.className = 'settings-status success'
      setTimeout(() => { statusEl.textContent = '' }, 2500)
    }
  })
}

const subagentActivityEl = document.getElementById('subagent-activity-visible')
if (subagentActivityEl) {
  subagentActivityEl.addEventListener('change', () => {
    setSubagentActivityVisible(subagentActivityEl.checked)
    const statusEl = document.getElementById('subagent-vis-status')
    if (statusEl) {
      statusEl.textContent = 'Saved'
      statusEl.className = 'settings-status success'
      setTimeout(() => { statusEl.textContent = '' }, 2500)
    }
  })
}

// Save button still works as explicit confirmation (already persisted by change handler)
const subagentVisSaveBtn = document.getElementById('subagent-vis-save-btn')
if (subagentVisSaveBtn) {
  subagentVisSaveBtn.addEventListener('click', () => {
    const promptEl = document.getElementById('subagent-prompt-visible')
    const activityEl = document.getElementById('subagent-activity-visible')
    if (promptEl) setSubagentPromptVisible(promptEl.checked)
    if (activityEl) setSubagentActivityVisible(activityEl.checked)
    const statusEl = document.getElementById('subagent-vis-status')
    if (statusEl) {
      statusEl.textContent = 'Saved'
      statusEl.className = 'settings-status success'
      setTimeout(() => { statusEl.textContent = '' }, 2500)
    }
  })
}

const autoResumeSaveBtn = document.getElementById('claude-autoresume-save-btn')
if (autoResumeSaveBtn) {
  autoResumeSaveBtn.addEventListener('click', async () => {
    const el = document.getElementById('claude-autoresume-enabled')
    const enabled = el ? el.checked : true
    localStorage.setItem(AUTORESUME_KEY, String(enabled))
    // Persist to server settings so the PTY launcher can read it
    try {
      await updateSetting('claude_autoresume', enabled ? '1' : '0')
    } catch {}
    const statusEl = document.getElementById('claude-autoresume-status')
    if (statusEl) {
      statusEl.textContent = 'Saved'
      statusEl.className = 'settings-status success'
      setTimeout(() => { statusEl.textContent = '' }, 2500)
    }
  })
}

// ─── P1-4: Auth status ───────────────────────────────────────────────────────

async function loadAuthStatus() {
  const el = document.getElementById('auth-status-display')
  if (!el) return
  try {
    const resp = await fetch('/api/auth/status')
    const data = await resp.json()
    if (data.loggedIn) {
      const parts = []
      if (data.email) parts.push(data.email)
      if (data.authMethod) parts.push(`(${data.authMethod})`)
      if (data.orgName) parts.push(`/ ${data.orgName}`)
      el.textContent = '登录账号：' + (parts.join(' ') || '已登录')
      el.style.color = 'var(--text-success, #4caf50)'
    } else {
      el.textContent = '未登录 — 请在终端运行 claude auth login'
      el.style.color = 'var(--text-error, #f44336)'
    }
  } catch {
    el.textContent = '无法获取账号状态'
    el.style.color = 'var(--text-secondary, #aaa)'
  }
}

// ─── P1-3: Model + Effort selectors ──────────────────────────────────────────

function loadClaudeModelSettings(serverSettings) {
  const sel = document.getElementById('claude-model-select')
  if (sel) sel.value = serverSettings?.claude_model || ''
}

function loadClaudeEffortSettings(serverSettings) {
  const sel = document.getElementById('claude-effort-select')
  if (sel) sel.value = serverSettings?.claude_effort || ''
}

const claudeModelSaveBtn = document.getElementById('claude-model-save-btn')
if (claudeModelSaveBtn) {
  claudeModelSaveBtn.addEventListener('click', async () => {
    const sel = document.getElementById('claude-model-select')
    const statusEl = document.getElementById('claude-model-status')
    try {
      await updateSetting('claude_model', sel?.value || '')
      if (statusEl) {
        statusEl.textContent = 'Saved'
        statusEl.className = 'settings-status success'
        setTimeout(() => { statusEl.textContent = '' }, 2500)
      }
    } catch (err) {
      if (statusEl) {
        statusEl.textContent = err.message
        statusEl.className = 'settings-status error'
        setTimeout(() => { statusEl.textContent = '' }, 3000)
      }
    }
  })
}

const claudeEffortSaveBtn = document.getElementById('claude-effort-save-btn')
if (claudeEffortSaveBtn) {
  claudeEffortSaveBtn.addEventListener('click', async () => {
    const sel = document.getElementById('claude-effort-select')
    const statusEl = document.getElementById('claude-effort-status')
    try {
      await updateSetting('claude_effort', sel?.value || '')
      if (statusEl) {
        statusEl.textContent = 'Saved'
        statusEl.className = 'settings-status success'
        setTimeout(() => { statusEl.textContent = '' }, 2500)
      }
    } catch (err) {
      if (statusEl) {
        statusEl.textContent = err.message
        statusEl.className = 'settings-status error'
        setTimeout(() => { statusEl.textContent = '' }, 3000)
      }
    }
  })
}

// ─── P2-5: Permission mode selector ──────────────────────────────────────────

function loadPermissionModeSettings(serverSettings) {
  const mode = serverSettings?.claude_permission_mode || 'bypass'
  const radios = document.querySelectorAll('input[name="claude-permission-mode"]')
  for (const r of radios) r.checked = r.value === mode
}

const permissionModeSaveBtn = document.getElementById('claude-permission-mode-save-btn')
if (permissionModeSaveBtn) {
  permissionModeSaveBtn.addEventListener('click', async () => {
    const selected = document.querySelector('input[name="claude-permission-mode"]:checked')
    const statusEl = document.getElementById('claude-permission-mode-status')
    try {
      await updateSetting('claude_permission_mode', selected?.value || 'bypass')
      if (statusEl) {
        statusEl.textContent = 'Saved — 新 session 生效'
        statusEl.className = 'settings-status success'
        setTimeout(() => { statusEl.textContent = '' }, 2500)
      }
    } catch (err) {
      if (statusEl) {
        statusEl.textContent = err.message
        statusEl.className = 'settings-status error'
        setTimeout(() => { statusEl.textContent = '' }, 3000)
      }
    }
  })
}

// ─── Claude Driver selector ───────────────────────────────────────────────────

function loadClaudeDriverSettings(serverSettings) {
  const sel = document.getElementById('claude-driver-select')
  if (sel) sel.value = serverSettings?.claude_driver || 'cli'
}

const claudeDriverSaveBtn = document.getElementById('claude-driver-save-btn')
if (claudeDriverSaveBtn) {
  claudeDriverSaveBtn.addEventListener('click', async () => {
    const sel = document.getElementById('claude-driver-select')
    const statusEl = document.getElementById('claude-driver-status')
    try {
      await updateSetting('claude_driver', sel?.value || 'cli')
      if (statusEl) {
        statusEl.textContent = 'Saved — 新 session 生效'
        statusEl.className = 'settings-status success'
        setTimeout(() => { statusEl.textContent = '' }, 2500)
      }
    } catch (err) {
      if (statusEl) {
        statusEl.textContent = err.message
        statusEl.className = 'settings-status error'
        setTimeout(() => { statusEl.textContent = '' }, 3000)
      }
    }
  })
}

// ─── Settings section collapse/expand toggles ────────────────────────────────

const SETTINGS_COLLAPSED_KEY = 'nanocodeSettingsCollapsed'

function _getCollapsedSections() {
  try { return JSON.parse(localStorage.getItem(SETTINGS_COLLAPSED_KEY)) || {} } catch { return {} }
}

function _saveCollapsedSections(map) {
  try { localStorage.setItem(SETTINGS_COLLAPSED_KEY, JSON.stringify(map)) } catch {}
}

function initSettingsSectionToggles() {
  const collapsed = _getCollapsedSections()
  document.querySelectorAll('.settings-section[data-section]').forEach((section) => {
    const key = section.dataset.section
    if (collapsed[key]) section.setAttribute('data-collapsed', 'true')
    const toggle = section.querySelector('.settings-section-toggle')
    if (toggle) {
      toggle.addEventListener('click', () => {
        const isCollapsed = section.getAttribute('data-collapsed') === 'true'
        if (isCollapsed) {
          section.removeAttribute('data-collapsed')
        } else {
          section.setAttribute('data-collapsed', 'true')
        }
        const map = _getCollapsedSections()
        map[key] = !isCollapsed
        _saveCollapsedSections(map)
      })
    }
  })
}

// ─── Dynamic model list from /api/claude/init-snapshot ───────────────────────

let _initSnapshotCache = null  // { data, ts }
const TTL_SNAPSHOT_MS = 60 * 60 * 1000  // 1h client-side

async function fetchInitSnapshot(forceRefresh = false) {
  const now = Date.now()
  if (!forceRefresh && _initSnapshotCache && (now - _initSnapshotCache.ts) < TTL_SNAPSHOT_MS) {
    return _initSnapshotCache.data
  }
  try {
    const url = forceRefresh ? '/api/claude/init-snapshot?refresh=1' : '/api/claude/init-snapshot'
    const resp = await fetch(url)
    if (!resp.ok) return null
    const data = await resp.json()
    _initSnapshotCache = { data, ts: Date.now() }
    return data
  } catch {
    return null
  }
}

function _applyDynamicModelOptions(snapshot) {
  const sel = document.getElementById('claude-model-select')
  if (!sel || !snapshot) return

  const currentVal = sel.value

  // Build model options: always include the blank "default" option
  const options = [{ value: '', label: '默认（CLI 决定）' }]

  // If snapshot has a current model, add it as first real option
  if (snapshot.model) {
    // Check if we already have this model in the hardcoded list
    const knownModels = [
      'claude-opus-4-5', 'claude-sonnet-4-5', 'claude-haiku-4-5',
      'claude-opus-4', 'claude-sonnet-4',
    ]
    const isKnown = knownModels.some(m => snapshot.model.includes(m.split('-').slice(0, 2).join('-')))
    if (!isKnown) {
      options.push({ value: snapshot.model, label: `${snapshot.model} (current)` })
    }
  }

  // Add standard hardcoded models
  options.push(
    { value: 'claude-opus-4-5', label: 'claude-opus-4-5' },
    { value: 'claude-sonnet-4-5', label: 'claude-sonnet-4-5' },
    { value: 'claude-haiku-4-5', label: 'claude-haiku-4-5' },
    { value: 'claude-opus-4', label: 'claude-opus-4' },
    { value: 'claude-sonnet-4', label: 'claude-sonnet-4' },
  )

  // Rebuild select options
  sel.innerHTML = ''
  for (const opt of options) {
    const el = document.createElement('option')
    el.value = opt.value
    el.textContent = opt.label
    sel.appendChild(el)
  }

  // Restore selection
  if (currentVal) {
    sel.value = currentVal
    // If the value doesn't match (model no longer in list), reset to default
    if (sel.value !== currentVal) sel.value = ''
  }

  // Add hint below select showing current active model
  const hint = sel.parentElement?.querySelector('.settings-current-model-hint')
  if (snapshot.model) {
    if (!hint) {
      const h = document.createElement('div')
      h.className = 'settings-current-model-hint settings-hint-inline'
      h.style.cssText = 'margin-top:4px;font-size:10px;'
      h.textContent = `当前 CLI 默认: ${snapshot.model}`
      sel.parentElement?.appendChild(h)
    } else {
      hint.textContent = `当前 CLI 默认: ${snapshot.model}`
    }
  }
}

// ─── Settings panel tab switch ────────────────────────────────────────────────

const settingsPanel = document.getElementById('settings-panel')
const settingsToggleBtn = document.getElementById('settings-toggle-btn')
const settingsPanelBackdrop = document.getElementById('settings-panel-backdrop')

async function openSettingsPanel() {
  settingsPanel?.classList.add('open')
  settingsPanelBackdrop?.classList.add('open')
  let serverSettings = {}
  try { serverSettings = await fetchSettings() } catch {}
  loadSettings(serverSettings)
  loadServices()
  loadAuthStatus()  // P1-4: refresh auth status on each open
  // Load dynamic model options in background
  fetchInitSnapshot().then((snapshot) => {
    if (snapshot) _applyDynamicModelOptions(snapshot)
  })
}

function closeSettingsPanel() {
  settingsPanel?.classList.remove('open')
  settingsPanelBackdrop?.classList.remove('open')
}

if (settingsToggleBtn) settingsToggleBtn.addEventListener('click', () => {
  settingsPanel?.classList.contains('open') ? closeSettingsPanel() : openSettingsPanel()
})
if (settingsPanelBackdrop) settingsPanelBackdrop.addEventListener('click', closeSettingsPanel)
const settingsPanelClose = document.getElementById('settings-panel-close')
if (settingsPanelClose) settingsPanelClose.addEventListener('click', closeSettingsPanel)
// Close settings on Escape key
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && settingsPanel?.classList.contains('open')) {
    closeSettingsPanel()
  }
})

// ─── Routing ──────────────────────────────────────────────────────────────────

function resolveProject(host, proj) {
  const candidates = state.projects.filter((p) => hostSlug(p) === host)
  return candidates.find((p) => projectSlug(p, state.projects) === proj)
    || candidates.find((p) => slugify(p.name) === proj)
    || null
}

function parseHash() {
  const hash = (location.hash.replace(/^#/, '') || '/').replace(/\/+$/, '') || '/'
  if (hash === '/') return { view: 'hosts' }
  const parts = hash.replace(/^\//, '').split('/')
  if (parts.length === 1) return { view: 'projects', host: parts[0] }
  return { view: 'workspace', host: parts[0], project: parts.slice(1).join('/') }
}

async function onHashChange() {
  const route = parseHash()
  if (route.view === 'workspace') {
    const project = resolveProject(route.host, route.project)
    if (!project) { navigateTo(`/${route.host}`); return }
    await enterWorkspace(project.id)
  } else if (route.view === 'projects') {
    await enterProjectPicker(route.host)
  } else {
    await enterHostPicker()
  }
}

async function enterHostPicker() {
  try { state.projects = await fetchProjects() } catch {}
  document.body.classList.remove('workspace-active')
  await showHosts(state.projects, navigateTo)
}

async function enterProjectPicker(host) {
  try { state.projects = await fetchProjects() } catch {}
  document.body.classList.remove('workspace-active')
  await showProjects(host, state.projects, navigateTo)
}

async function enterWorkspace(projectId) {
  hideLanding()
  document.body.classList.add('workspace-active')
  state.activeProjectId = projectId
  localStorage.setItem('activeProjectId', projectId)
  // P1+P2 fix: close settings panel and agent drawer on every workspace entry
  // to prevent residual open state from previous session
  closeSettingsPanel()
  const agentDrawer = document.getElementById('agent-drawer')
  const agentDrawerBackdrop = document.getElementById('agent-drawer-backdrop')
  const agentDrawerToggle = document.getElementById('agent-drawer-toggle')
  agentDrawer?.classList.remove('open')
  agentDrawerBackdrop?.classList.remove('open')
  agentDrawerToggle?.classList.remove('active')
  renderSidebar()
  if (!workspaceReady) {
    workspaceReady = true
    await initTerminalView(projectId)
  } else {
    switchTerminalProject(projectId)
    if (isInitialized()) fitTerminals()
  }
}

async function onProjectSwitch(projectId) {
  const project = state.projects.find((p) => p.id === projectId)
  if (project) navigateTo(projectPath(project, state.projects))
}

// ─── Init ─────────────────────────────────────────────────────────────────────

async function init() {
  initThemeToggle()
  initNotifyWs()
  initAgentDrawer()
  initSettingsSectionToggles()
  try { state.projects = await fetchProjects() } catch { state.projects = [] }
  initSidebar(onProjectSwitch)

  try {
    const settings = await fetchSettings()
    if (settings.cli_provider) state.cliProvider = settings.cli_provider
    if (settings.font_size) state.fontSize = settings.font_size
    if (settings.renderMode) state.renderMode = settings.renderMode
    // codexRenderMode defaults to 'terminal' — only override if explicitly set
    if (settings.codexRenderMode) state.codexRenderMode = settings.codexRenderMode
  } catch {}

  const backBtn = document.getElementById('back-to-menu')
  if (backBtn) {
    backBtn.addEventListener('click', () => {
      const route = parseHash()
      if (route.view === 'workspace') navigateTo(`/${route.host}`)
      else navigateTo('/')
    })
  }

  window.addEventListener('hashchange', onHashChange)
  await onHashChange()
}

init()
