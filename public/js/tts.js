/**
 * Text-to-Speech module for Nanocode (GPT-SoVITS v3 backend).
 * Listens on document 'nanocode:terminal-output' custom events.
 * Extracts [TTS_START]...[TTS_END] content and enqueues for playback.
 */

let ttsEnabled = localStorage.getItem('ttsEnabled') === 'true'
let ttsStreaming = localStorage.getItem('ttsStreaming') === 'true'
let ttsAvailable = false
let ttsAudioUnlocked = false
let ttsAudio = null
let ttsQueue = []
let ttsPlaying = false
let ttsBuffer = ''
let ttsDebounceTimer = null
const TTS_DEBOUNCE_MS = 1500
const ttsPlayedHashes = new Set()
let ttsLastText = ''
let ttsFirstCheck = true

const ttsLogPanel = document.getElementById('tts-log-panel')
const ttsCheckbox = document.getElementById('tts-enabled')
const ttsStreamingCheckbox = document.getElementById('tts-streaming')
const ttsStatusDot = document.getElementById('tts-status-dot')
const ttsStatusText = document.getElementById('tts-status-text')
const ttsRefAudioInput = document.getElementById('tts-ref-audio')
const ttsPromptTextInput = document.getElementById('tts-prompt-text')
const ttsSaveBtn = document.getElementById('tts-save-btn')
const ttsTestBtn = document.getElementById('tts-test-btn')
const ttsSaveStatus = document.getElementById('tts-status')

function ttsLog(msg, level = 'ok') {
  const ts = new Date().toLocaleTimeString()
  const line = `[${ts}] ${msg}`
  console.log('[TTS]', msg)
  if (ttsLogPanel) {
    const el = document.createElement('div')
    el.className = 'tts-log-entry ' + level
    el.textContent = line
    ttsLogPanel.appendChild(el)
    if (ttsLogPanel.children.length > 100) ttsLogPanel.removeChild(ttsLogPanel.firstChild)
    ttsLogPanel.scrollTop = ttsLogPanel.scrollHeight
  }
}

// Unlock audio on first user interaction (iOS/Chrome autoplay policy)
function unlockAudio() {
  if (ttsAudioUnlocked) return
  const ctx = new (window.AudioContext || window.webkitAudioContext)()
  const buf = ctx.createBuffer(1, 1, 22050)
  const src = ctx.createBufferSource()
  src.buffer = buf
  src.connect(ctx.destination)
  src.start(0)
  ttsAudioUnlocked = true
}
document.addEventListener('click', unlockAudio, { once: false })
document.addEventListener('touchstart', unlockAudio, { once: false })

function showTtsToast(msg, duration = 4000) {
  let el = document.getElementById('tts-toast')
  if (!el) {
    el = document.createElement('div')
    el.id = 'tts-toast'
    el.style.cssText = 'position:fixed;bottom:80px;left:50%;transform:translateX(-50%);background:rgba(30,30,30,0.95);color:#f0f0f0;padding:10px 20px;border-radius:10px;font-size:14px;z-index:9999;pointer-events:none;opacity:0;transition:opacity 0.3s;backdrop-filter:blur(12px);border:1px solid rgba(255,255,255,0.1);'
    document.body.appendChild(el)
  }
  el.textContent = msg
  el.style.opacity = '1'
  clearTimeout(el._timer)
  el._timer = setTimeout(() => { el.style.opacity = '0' }, duration)
}

function updateTtsUi() {
  if (ttsCheckbox) ttsCheckbox.checked = ttsEnabled
  if (ttsStreamingCheckbox) ttsStreamingCheckbox.checked = ttsStreaming
}

function setTtsEnabled(v) {
  ttsEnabled = v
  localStorage.setItem('ttsEnabled', v)
  updateTtsUi()
  if (!v) stopTts()
}

function stopTts() {
  if (ttsAudio) { ttsAudio.pause(); ttsAudio = null }
  ttsQueue = []
  ttsPlaying = false
  ttsBuffer = ''
  if (ttsDebounceTimer) { clearTimeout(ttsDebounceTimer); ttsDebounceTimer = null }
}

function stripAnsi(s) {
  return s
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b[PX^_][^\x1b]*\x1b\\/g, '')
    .replace(/\x1b[^[\]PX^_\r\n]/g, '')
    .replace(/\r/g, '')
}

async function playTtsNonStreaming(text) {
  ttsLog('Requesting: ' + text.slice(0, 50))
  const res = await fetch('/api/tts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  })
  if (!res.ok) { ttsLog('Fetch failed: ' + res.status, 'err'); throw new Error(`TTS fetch ${res.status}`) }
  const blob = await res.blob()
  ttsLog('Received: ' + blob.size + ' bytes, type: ' + blob.type)
  const url = URL.createObjectURL(blob)
  ttsAudio = new Audio(url)
  await new Promise((resolve, reject) => {
    ttsAudio.onended = () => { ttsLog('Playback ended', 'ok'); URL.revokeObjectURL(url); ttsAudio = null; resolve() }
    ttsAudio.onerror = () => { ttsLog('Audio decode error', 'err'); URL.revokeObjectURL(url); ttsAudio = null; reject(new Error('Audio decode error')) }
    ttsAudio.play().then(() => ttsLog('Playing...', 'ok')).catch((e) => { ttsLog('Play blocked: ' + e.message, 'err'); reject(e) })
  })
}

async function playTtsStreaming(text) {
  ttsLog('Streaming: ' + text.slice(0, 50))
  const url = '/api/tts/stream?' + new URLSearchParams({ text })
  ttsAudio = new Audio(url)
  await new Promise((resolve, reject) => {
    ttsAudio.onended = () => { ttsLog('Stream ended', 'ok'); ttsAudio = null; resolve() }
    ttsAudio.onerror = () => { ttsLog('Stream error', 'err'); ttsAudio = null; reject(new Error('Stream decode error')) }
    ttsAudio.play().then(() => ttsLog('Stream playing...', 'ok')).catch((e) => { ttsLog('Play blocked: ' + e.message, 'err'); reject(e) })
  })
}

function _isGloballyMuted() {
  try { return localStorage.getItem('nanocodeMuted') === 'true' } catch { return false }
}

async function playNextTts() {
  if (ttsPlaying || !ttsQueue.length) return
  if (_isGloballyMuted()) {
    // Discard queue silently when muted
    ttsQueue = []
    ttsPlaying = false
    return
  }
  const text = ttsQueue.shift()
  if (!text.trim()) { playNextTts(); return }
  ttsPlaying = true
  try {
    if (ttsStreaming) {
      await playTtsStreaming(text)
    } else {
      await playTtsNonStreaming(text)
    }
  } catch (e) {
    ttsLog('Failed: ' + e.message, 'err')
    if (e.message.includes('502') || e.message.includes('503') || e.message.includes('fetch')) {
      showTtsToast('Voice service restarting, please wait...')
    }
  }
  ttsPlaying = false
  playNextTts()
}

function simpleHash(s) {
  let h = 0
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0
  return h.toString(36)
}

function setLastTtsText(text) {
  ttsLastText = text
}

function enqueueTts(text) {
  if (!ttsEnabled || !ttsAvailable || _isGloballyMuted()) return
  const hash = simpleHash(text)
  if (ttsPlayedHashes.has(hash)) { ttsLog('Skipped duplicate: ' + text.slice(0, 40), 'skip'); return }
  if (ttsQueue.some(t => simpleHash(t) === hash)) { ttsLog('Skipped queued: ' + text.slice(0, 40), 'skip'); return }
  ttsLog('Enqueued: ' + text.slice(0, 50))
  ttsPlayedHashes.add(hash)
  if (ttsPlayedHashes.size > 200) {
    const first = ttsPlayedHashes.values().next().value
    ttsPlayedHashes.delete(first)
  }
  setLastTtsText(text)
  ttsQueue.push(text)
  playNextTts()
}

function onTerminalOutput(rawData) {
  if (!ttsEnabled || !ttsAvailable) return
  const clean = stripAnsi(rawData)
  if (!clean.trim()) return
  ttsBuffer += clean
  if (ttsDebounceTimer) clearTimeout(ttsDebounceTimer)
  ttsDebounceTimer = setTimeout(() => {
    const buf = ttsBuffer
    ttsBuffer = ''
    const re = /\[TTS_START\]([\s\S]*?)\[TTS_END\]/g
    let match
    const parts = []
    while ((match = re.exec(buf)) !== null) {
      const t = match[1].trim()
      if (t) parts.push(t)
    }
    for (const part of parts) {
      ttsLog('Extracted: ' + part.slice(0, 80))
      enqueueTts(part)
    }
  }, TTS_DEBOUNCE_MS)
}

async function checkTtsStatus() {
  const wasPreviouslyAvailable = ttsAvailable
  try {
    const res = await fetch('/api/tts/status')
    const data = await res.json()
    ttsAvailable = data.available
    if (data.config) {
      if (ttsRefAudioInput && !ttsRefAudioInput.value) ttsRefAudioInput.value = data.config.ref_audio_path || ''
      if (ttsPromptTextInput && !ttsPromptTextInput.value) ttsPromptTextInput.value = data.config.prompt_text || ''
    }
  } catch {
    ttsAvailable = false
  }
  if (ttsStatusDot) {
    ttsStatusDot.className = 'tts-status-dot ' + (ttsAvailable ? 'available' : 'unavailable')
  }
  if (ttsStatusText) {
    ttsStatusText.textContent = ttsAvailable ? 'Service connected' : 'Service unavailable'
    ttsStatusText.style.color = ttsAvailable ? '#4caf50' : 'var(--fg-3)'
  }
  if (ttsFirstCheck && ttsAvailable && !ttsEnabled) {
    showTtsToast('TTS available — tap the speaker icon to enable voice')
  }
  updateTtsUi()
  ttsFirstCheck = false
}

// ─── Wire up UI ───────────────────────────────────────────────────────────────

// Listen for terminal output via custom event
document.addEventListener('nanocode:terminal-output', (e) => onTerminalOutput(e.detail))

if (ttsCheckbox) ttsCheckbox.addEventListener('change', () => setTtsEnabled(ttsCheckbox.checked))
if (ttsStreamingCheckbox) ttsStreamingCheckbox.addEventListener('change', () => {
  ttsStreaming = ttsStreamingCheckbox.checked
  localStorage.setItem('ttsStreaming', ttsStreaming)
})
if (ttsSaveBtn) ttsSaveBtn.addEventListener('click', async () => {
  const ref = ttsRefAudioInput?.value?.trim()
  const prompt = ttsPromptTextInput?.value?.trim()
  if (!ref) { if (ttsSaveStatus) ttsSaveStatus.textContent = 'Reference audio path required'; return }
  try {
    const res = await fetch('/api/tts/voice', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ref_audio_path: ref, prompt_text: prompt, prompt_lang: 'zh' }),
    })
    const data = await res.json()
    if (ttsSaveStatus) ttsSaveStatus.textContent = data.ok ? 'Saved!' : (data.error || 'Error')
  } catch {
    if (ttsSaveStatus) ttsSaveStatus.textContent = 'Failed to save'
  }
})
if (ttsTestBtn) ttsTestBtn.addEventListener('click', async () => {
  unlockAudio()
  if (ttsSaveStatus) ttsSaveStatus.textContent = 'Fetching audio...'
  const testText = '你好，TTS 语音测试成功了喵。'
  try {
    await playTtsNonStreaming(testText)
    if (ttsSaveStatus) ttsSaveStatus.textContent = 'Test OK! Audio played.'
  } catch (e) {
    ttsLog('Test failed: ' + e.message, 'err')
    if (ttsSaveStatus) ttsSaveStatus.textContent = 'Failed: ' + e.message
  }
})

// Voice input via Web Speech API
const micBtn = document.getElementById('mic-btn')
const chatInput = document.getElementById('chat-input')
if (micBtn && chatInput) {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition
  if (SpeechRecognition) {
    const recognition = new SpeechRecognition()
    recognition.continuous = true
    recognition.interimResults = true
    recognition.lang = '' // auto-detect

    let baseText = ''
    let insertPos = 0

    recognition.addEventListener('result', (e) => {
      let full = ''
      for (let i = 0; i < e.results.length; i++) {
        full += e.results[i][0].transcript
      }
      chatInput.value = baseText.slice(0, insertPos) + full + baseText.slice(insertPos)
      chatInput.dispatchEvent(new Event('input', { bubbles: true }))
    })

    recognition.addEventListener('end', () => {
      micBtn.classList.remove('recording')
    })

    recognition.addEventListener('error', () => {
      micBtn.classList.remove('recording')
    })

    micBtn.addEventListener('click', () => {
      if (micBtn.classList.contains('recording')) {
        recognition.stop()
      } else {
        baseText = chatInput.value
        insertPos = chatInput.selectionStart || chatInput.value.length
        micBtn.classList.add('recording')
        recognition.start()
      }
    })
  } else {
    micBtn.style.display = 'none'
  }
}

// Initialize
updateTtsUi()
checkTtsStatus()
setInterval(checkTtsStatus, 30000)
