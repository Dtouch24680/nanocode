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

// ─── Settings panel (CLI provider + font size + ntfy + renderMode) ────────────

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

function loadRenderModeSettings(serverSettings) {
  const mode = (serverSettings?.renderMode) || 'block'
  const radios = renderModeGroup?.querySelectorAll('input[name="render-mode"]')
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
  try { state.projects = await fetchProjects() } catch { state.projects = [] }
  initSidebar(onProjectSwitch)

  try {
    const settings = await fetchSettings()
    if (settings.cli_provider) state.cliProvider = settings.cli_provider
    if (settings.font_size) state.fontSize = settings.font_size
    if (settings.renderMode) state.renderMode = settings.renderMode
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
