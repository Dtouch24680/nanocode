/**
 * Terminal view — multi-tab bash on the left, chat input bar at the bottom.
 *
 * Tab key in the composer cycles tabs (forward; Shift+Tab cycles backward).
 * Ctrl+T creates a new tab; Ctrl+W closes the active one; Ctrl+1..9 jumps.
 */

import { initSplitPane } from './terminal-pane.js'
import { TabManager, TYPE_ICON_SVG } from './tab-manager.js'
import { createExplorer } from './explorer.js'

const mobileQuery = window.matchMedia('(max-width: 768px)')
const isMobile = () => mobileQuery.matches

let initialized = false
let tabManager = null
let activePane = null
let explorer = null
let currentProjectId = null

const statusBash = document.getElementById('status-bash')

// Label prefix per tab type for the connection badge in the header.
const TAB_TYPE_LABEL = {
  bash: 'Bash',
  claude: 'Claude',
  codex: 'Codex',
  agent: 'Agent',
  opencode: 'OpenCode',
}

let _activeTabType = 'bash'

function setStatus(connected) {
  if (!statusBash) return
  const label = TAB_TYPE_LABEL[_activeTabType] || 'Bash'
  statusBash.textContent = `${label}: ${connected ? 'connected' : 'disconnected'}`
  statusBash.classList.toggle('connected', connected)
}

/**
 * Initialize the terminal view for a given project.
 * @param {string} projectId
 */
export async function initTerminalView(projectId) {
  if (!projectId) return
  currentProjectId = projectId

  if (!initialized) {
    initialized = true
    setupSplitPane()
    setupTabs(projectId)
    setupExplorer(projectId)
    setupChatInput()
    setupKeyboardShortcuts()
    setupMobile()
  } else {
    if (tabManager) tabManager.switchProject(projectId)
    if (explorer) explorer.switchProject(projectId)
  }
}

/**
 * Switch the terminal view to a new project.
 * @param {string} projectId
 */
export function switchTerminalProject(projectId) {
  if (!projectId || !initialized) return
  if (projectId === currentProjectId) return
  currentProjectId = projectId
  if (tabManager) tabManager.switchProject(projectId)
  if (explorer) explorer.switchProject(projectId)
}

export function fitTerminals() {
  if (tabManager) tabManager.fit()
}

export function isInitialized() {
  return initialized
}

// --- Internal ---

function setupSplitPane() {
  initSplitPane(
    document.getElementById('split-container'),
    document.getElementById('split-divider')
  )
}

function setupExplorer(projectId) {
  const root = document.getElementById('explorer-root')
  if (!root) return
  explorer = createExplorer(root, projectId)

  // Feature 2: listen for path-click events from chat bubble renderer
  // The event bubbles up from wherever in the DOM the clicked span lives.
  document.addEventListener('nanocode:open-in-explorer', (e) => {
    const path = e.detail?.path
    if (!path || !explorer) return
    explorer.openPath(path).catch(() => {})
  })

  // Cross-project switch requested by openPath (method C, step 1)
  document.addEventListener('nanocode:switch-project', (e) => {
    const { projectId } = e.detail || {}
    if (!projectId) return
    switchTerminalProject(projectId)
  })
}

function setupTabs(projectId) {
  const stripEl = document.getElementById('terminal-tab-strip')
  const stackEl = document.getElementById('terminal-stack')
  if (!stripEl || !stackEl) return

  tabManager = new TabManager({
    stripEl,
    stackEl,
    projectId,
    onActiveChange: (pane, tabMeta) => {
      activePane = pane
      if (tabMeta && tabMeta.type) _activeTabType = tabMeta.type
      updateActiveTabChip()
      // Re-render badge with correct label and current connection state
      if (pane && pane._ws) {
        setStatus(pane._ws.readyState === WebSocket.OPEN)
      } else {
        setStatus(false)
      }
      // Notify chat input bar about tab type change
      document.dispatchEvent(new CustomEvent('nanocode:tab-active', {
        detail: { type: tabMeta?.type || 'bash', tabId: tabMeta?.id },
      }))
    },
    onStatusChange: setStatus,
  })
  tabManager.restore()
  // Re-render carousel when window resizes (recompute translateX so
  // the active slot stays centered).
  window.addEventListener('resize', () => updateActiveTabChip({ noAnim: true }))
}

// ── Session resume from agent-list ──────────────────────────────────────────
//
// When the user clicks a recent-agent entry, agents.js dispatches
// 'nanocode:resume-session' with { projectId, sessionId }.
// We ensure we're in the right workspace, then find or create the claude tab
// that owns that sessionId and activate it. The tab-manager's history fetch
// already handles the jsonl replay via ClaudeBlockRenderer.

document.addEventListener('nanocode:resume-session', async (e) => {
  const { projectId, sessionId } = e.detail || {}
  if (!projectId || !sessionId) return

  // Make sure we are in the right workspace
  if (currentProjectId !== projectId) {
    // switchTerminalProject will be called by the hash-change handler; wait briefly
    await new Promise(resolve => setTimeout(resolve, 300))
  }

  if (!tabManager) return

  // Find a claude tab with this sessionId
  try {
    const tabs = await fetch(`/api/projects/${projectId}/tabs`).then(r => r.json())
    const match = tabs.find(t => t.type === 'claude' && t.claudeSessionId === sessionId)
    if (match) {
      // Tab exists — just activate it
      if (tabManager.projectId === projectId) {
        tabManager.setActive(match.id)
      } else {
        tabManager._pendingActiveId = match.id
      }
    } else {
      // Create a new claude tab pre-loaded with this sessionId
      const newTab = await fetch(`/api/projects/${projectId}/tabs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'claude', label: `resume` }),
      }).then(r => r.json())

      // Patch the tab's claudeSessionId to point at the target session
      // so the history endpoint finds the right jsonl
      if (newTab?.id) {
        await fetch(`/api/projects/${projectId}/tabs/${newTab.id}/session`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ claudeSessionId: sessionId }),
        }).catch(() => {})
        tabManager._pendingActiveId = newTab.id
      }
    }
  } catch (err) {
    console.warn('[resume-session] error', err)
  }
})

const SLOT_WIDTH_PX = 110
const SLOT_GAP_PX = 4

/**
 * Render the carousel of all tabs and translate the track so the active
 * tab is horizontally centered in the viewport. The animation comes
 * from the CSS transition on .tab-slot-track's transform.
 */
function updateActiveTabChip(opts = {}) {
  const chip = document.getElementById('active-tab-chip')
  const track = document.getElementById('tab-slot-track')
  if (!chip || !track || !tabManager) return

  const tabs = tabManager.tabs
  const activeId = tabManager.activeId
  if (!tabs.length || !activeId) {
    chip.hidden = true
    return
  }
  chip.hidden = false

  // Rebuild slot DOM only when the tab set changes (id list); otherwise
  // update labels + classes in place so the existing slot elements
  // keep their transform animation continuity.
  const wantIds = tabs.map((t) => t.id).join(',')
  if (track.dataset.tabIds !== wantIds) {
    track.innerHTML = ''
    for (const t of tabs) {
      const slot = document.createElement('button')
      slot.type = 'button'
      slot.className = 'tab-slot type-' + (t.type || 'bash')
      slot.dataset.tabId = t.id
      slot.innerHTML =
        `<span class="tab-slot-icon">${TYPE_ICON_SVG[t.type || 'bash'] || TYPE_ICON_SVG.bash}</span>` +
        `<span class="tab-slot-label"></span>`
      slot.querySelector('.tab-slot-label').textContent = t.label
      slot.addEventListener('click', () => {
        if (tabManager && t.id !== tabManager.activeId) tabManager.setActive(t.id)
      })
      track.appendChild(slot)
    }
    track.dataset.tabIds = wantIds
  } else {
    // Label/type updates: refresh in place
    const slotEls = track.children
    tabs.forEach((t, i) => {
      const slot = slotEls[i]
      if (!slot) return
      slot.className = 'tab-slot type-' + (t.type || 'bash')
      const labelEl = slot.querySelector('.tab-slot-label')
      if (labelEl && labelEl.textContent !== t.label) labelEl.textContent = t.label
    })
  }

  // Active class
  for (const slot of track.children) {
    slot.classList.toggle('active', slot.dataset.tabId === activeId)
  }

  // Center the active slot via translateX
  const activeIdx = tabs.findIndex((t) => t.id === activeId)
  if (activeIdx < 0) return
  const containerW = chip.getBoundingClientRect().width
  const slotPitch = SLOT_WIDTH_PX + SLOT_GAP_PX
  const activeSlotCenter = activeIdx * slotPitch + SLOT_WIDTH_PX / 2
  const containerCenter = containerW / 2
  const translateX = Math.round(containerCenter - activeSlotCenter)

  if (opts.noAnim) {
    track.classList.add('no-anim')
    track.style.transform = `translateX(${translateX}px)`
    // Force layout, then drop the no-anim flag so subsequent updates animate.
    void track.offsetWidth
    track.classList.remove('no-anim')
  } else {
    track.style.transform = `translateX(${translateX}px)`
  }
}

// Claude slash commands for the dropdown
const CLAUDE_SLASH_COMMANDS = [
  { cmd: '/clear',   hint: 'Clear conversation history' },
  { cmd: '/compact', hint: 'Compact context' },
  { cmd: '/help',    hint: 'Show help' },
  { cmd: '/exit',    hint: 'Exit Claude Code' },
  { cmd: '/status',  hint: 'Show session status' },
  { cmd: '/restart', hint: 'Restart session' },
]

function setupChatInput() {
  const chatInput = document.getElementById('chat-input')
  const sendBtn = document.getElementById('send-btn')
  const suggestionsDropdown = document.getElementById('suggestions-dropdown')

  if (!chatInput || !sendBtn) return

  // ── Claude tab stop button ────────────────────────────────────────────────
  // Inject a Stop button into the input-row (next to send-btn) at init time.
  const inputRow = chatInput.closest('.input-row')
  const stopBtn = document.createElement('button')
  stopBtn.type = 'button'
  stopBtn.id = 'claude-stop-btn'
  stopBtn.className = 'claude-stop-btn'
  stopBtn.setAttribute('aria-label', 'Stop Claude')
  stopBtn.title = 'Stop Claude (interrupt)'
  stopBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>`
  stopBtn.hidden = true
  // Insert before send-btn
  sendBtn.parentNode.insertBefore(stopBtn, sendBtn)

  // ── State ─────────────────────────────────────────────────────────────────
  let isClaudeTab = false      // is the active tab a claude tab?
  let isClaudeThinking = false // is claude currently thinking?
  let claudeSlashOpen = false  // is the slash commands dropdown open?

  function updateInputBarForTabType() {
    const tabType = _activeTabType
    isClaudeTab = tabType === 'claude'
    if (isClaudeTab) {
      chatInput.placeholder = 'Message Claude… (/ for commands)'
    } else {
      chatInput.placeholder = 'Type a command...'
    }
    // Stop btn only visible when claude is thinking
    updateThinkingState(isClaudeThinking && isClaudeTab)
  }

  function updateThinkingState(thinking) {
    isClaudeThinking = thinking
    if (isClaudeTab && thinking) {
      chatInput.classList.add('claude-thinking')
      stopBtn.hidden = false
      sendBtn.hidden = true
    } else {
      chatInput.classList.remove('claude-thinking')
      stopBtn.hidden = true
      sendBtn.hidden = false
    }
  }

  // Listen for tab switches
  const origOnActiveChange = tabManager ? null : null  // will hook via event
  document.addEventListener('nanocode:tab-active', (e) => {
    _activeTabType = e.detail?.type || 'bash'
    isClaudeThinking = false  // reset on tab switch
    updateInputBarForTabType()
  })

  // Listen for claude thinking state changes
  document.addEventListener('nanocode:claude-thinking', (e) => {
    const detail = e.detail || {}
    // Only react if this is the active tab
    const activeId = tabManager ? tabManager.activeId : null
    if (!activeId || detail.tabId !== activeId) return
    updateThinkingState(!!detail.thinking)
  })

  // Stop button click: POST interrupt to backend
  stopBtn.addEventListener('click', async () => {
    if (!tabManager) return
    const activeTab = tabManager.tabs?.find((t) => t.id === tabManager.activeId)
    if (!activeTab) return
    const projectId = tabManager.projectId
    const tabId = activeTab.id
    try {
      await fetch(`/api/projects/${projectId}/tabs/${tabId}/interrupt`, { method: 'POST' })
    } catch {}
    // Optimistically reset thinking state
    updateThinkingState(false)
  })

  // ── Slash-command dropdown for Claude tabs ────────────────────────────────
  function showSlashCommands(query) {
    if (!isClaudeTab) return
    // query is the text after '/', e.g. '' or 'cl' or 'help'
    const q = query.toLowerCase()
    const matches = q
      ? CLAUDE_SLASH_COMMANDS.filter((c) => c.cmd.slice(1).startsWith(q))
      : CLAUDE_SLASH_COMMANDS

    if (!matches.length) {
      hideSlashCommands()
      return
    }
    claudeSlashOpen = true
    suggestionsDropdown.innerHTML = ''
    for (const opt of matches) {
      const item = document.createElement('div')
      item.className = 'suggestion-item claude-slash-item'
      item.innerHTML =
        `<span class="claude-slash-cmd">${opt.cmd}</span>` +
        `<span class="claude-slash-hint">${opt.hint}</span>`
      item.addEventListener('mousedown', (e) => {
        e.preventDefault()
        chatInput.value = opt.cmd + ' '
        autoResize()
        hideSlashCommands()
        chatInput.focus()
      })
      suggestionsDropdown.appendChild(item)
    }
    suggestionsDropdown.hidden = false
  }

  function hideSlashCommands() {
    claudeSlashOpen = false
    if (suggestionsDropdown) {
      suggestionsDropdown.hidden = true
      suggestionsDropdown.innerHTML = ''
    }
  }

  const HISTORY_KEY = 'cmdHistory'
  const MAX_HISTORY = 200

  function loadHistory() {
    try {
      const raw = localStorage.getItem(HISTORY_KEY)
      if (raw) {
        const parsed = JSON.parse(raw)
        if (Array.isArray(parsed)) return parsed
        if (Array.isArray(parsed.bash)) return parsed.bash
      }
    } catch {}
    return []
  }

  function saveHistory() {
    try { localStorage.setItem(HISTORY_KEY, JSON.stringify(history)) } catch {}
  }

  const history = loadHistory()
  let historyIdx = -1
  let historyDraft = ''
  let selectedSuggestion = -1

  function pushHistory(text) {
    if (history.length && history[history.length - 1] === text) return
    history.push(text)
    if (history.length > MAX_HISTORY) history.splice(0, history.length - MAX_HISTORY)
    saveHistory()
  }

  function resetHistoryNav() {
    historyIdx = -1
    historyDraft = ''
  }

  function showSuggestions(query) {
    if (!suggestionsDropdown || !query.trim()) {
      hideSuggestions()
      return
    }
    const q = query.toLowerCase()
    const seen = new Set()
    const matches = []
    for (let i = history.length - 1; i >= 0 && matches.length < 12; i--) {
      const cmd = history[i]
      if (seen.has(cmd)) continue
      if (cmd.toLowerCase().includes(q)) {
        seen.add(cmd)
        matches.push(cmd)
      }
    }
    if (!matches.length) {
      hideSuggestions()
      return
    }
    selectedSuggestion = -1
    suggestionsDropdown.innerHTML = ''
    for (let i = 0; i < matches.length; i++) {
      const cmd = matches[i]
      const item = document.createElement('div')
      item.className = 'suggestion-item'
      item.dataset.index = i
      const textEl = document.createElement('span')
      textEl.className = 'suggestion-text'
      const matchIdx = cmd.toLowerCase().indexOf(q)
      if (matchIdx >= 0) {
        textEl.innerHTML =
          escapeHtml(cmd.slice(0, matchIdx)) +
          '<mark>' +
          escapeHtml(cmd.slice(matchIdx, matchIdx + q.length)) +
          '</mark>' +
          escapeHtml(cmd.slice(matchIdx + q.length))
      } else {
        textEl.textContent = cmd
      }
      item.appendChild(textEl)
      item.addEventListener('mousedown', (e) => {
        e.preventDefault()
        chatInput.value = cmd
        autoResize()
        hideSuggestions()
        chatInput.focus()
      })
      suggestionsDropdown.appendChild(item)
    }
    const hint = document.createElement('div')
    hint.className = 'suggestions-hint'
    hint.textContent = '↑↓ navigate · Enter accept · Esc dismiss'
    suggestionsDropdown.appendChild(hint)
    suggestionsDropdown.hidden = false
  }

  function hideSuggestions() {
    if (suggestionsDropdown) {
      suggestionsDropdown.hidden = true
      suggestionsDropdown.innerHTML = ''
    }
    selectedSuggestion = -1
  }

  function selectSuggestion(direction) {
    const items = suggestionsDropdown.querySelectorAll('.suggestion-item')
    if (!items.length) return false
    if (selectedSuggestion >= 0 && selectedSuggestion < items.length) {
      items[selectedSuggestion].classList.remove('selected')
    }
    selectedSuggestion += direction
    if (selectedSuggestion < 0) selectedSuggestion = items.length - 1
    if (selectedSuggestion >= items.length) selectedSuggestion = 0
    items[selectedSuggestion].classList.add('selected')
    items[selectedSuggestion].scrollIntoView({ block: 'nearest' })
    return true
  }

  function getSelectedSuggestionText() {
    if (selectedSuggestion < 0) return null
    const items = suggestionsDropdown.querySelectorAll('.suggestion-item')
    if (selectedSuggestion >= items.length) return null
    const textEl = items[selectedSuggestion].querySelector('.suggestion-text')
    return textEl ? textEl.textContent : null
  }

  function escapeHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  }

  function autoResize() {
    // For empty input, clear the inline height so the CSS rule
    // (height: 38px) takes over cleanly — guarantees pixel-exact
    // alignment with the send button on the empty/single-line state.
    if (!chatInput.value) {
      chatInput.style.height = ''
      chatInput.style.overflowY = 'hidden'
      return
    }
    chatInput.style.height = 'auto'
    // Floor at 38 so even rounding-down scrollHeight values can't
    // make the textarea shorter than its siblings.
    const next = Math.max(38, Math.min(chatInput.scrollHeight, 120))
    chatInput.style.height = next + 'px'
    chatInput.style.overflowY = chatInput.scrollHeight > 120 ? 'auto' : 'hidden'
  }

  // ── Feature 1: Queue-choice dialog ───────────────────────────────────────
  // When claude is busy, instead of silently enqueuing, we show an inline
  // banner with two actions: "排队" (enqueue) or "打断并发送" (interrupt+send).
  // The banner is appended to .cbr-scroll of the active pane and removes
  // itself once the user picks an action.

  let _queueChoiceBanner = null

  function dismissQueueBanner() {
    if (_queueChoiceBanner) {
      _queueChoiceBanner.remove()
      _queueChoiceBanner = null
    }
  }

  function showQueueChoiceBanner(text) {
    dismissQueueBanner()

    // Find the scroll container of the active CBR pane
    const container = activePane?.container || activePane?._scroll?.parentElement
    const scroll = container?.querySelector('.cbr-scroll') || activePane?._scroll
    if (!scroll) {
      // Fallback: just enqueue silently
      if (activePane) activePane.sendInputWithEcho(text)
      return
    }

    const banner = document.createElement('div')
    banner.className = 'cbr-queue-banner'
    banner.innerHTML =
      `<span class="cbr-queue-banner-msg">Claude 正忙：</span>` +
      `<button class="cbr-queue-btn cbr-queue-enqueue" title="等当前回合完成再发送">排队</button>` +
      `<button class="cbr-queue-btn cbr-queue-interrupt" title="立即中断当前回合并发送">打断并发送</button>` +
      `<button class="cbr-queue-btn cbr-queue-cancel" title="取消">取消</button>`
    scroll.appendChild(banner)
    scroll.scrollTop = scroll.scrollHeight
    _queueChoiceBanner = banner

    banner.querySelector('.cbr-queue-enqueue').addEventListener('click', () => {
      dismissQueueBanner()
      // Send normally — server will enqueue since it's busy
      if (activePane) activePane.sendInputWithEcho(text)
      pushHistory(text)
      resetHistoryNav()
      chatInput.focus()
    })

    banner.querySelector('.cbr-queue-interrupt').addEventListener('click', async () => {
      dismissQueueBanner()
      // Interrupt the current turn, then send
      const activeTab = tabManager?.tabs?.find((t) => t.id === tabManager.activeId)
      const projectId = tabManager?.projectId
      if (activeTab && projectId) {
        try {
          await fetch(`/api/projects/${projectId}/tabs/${activeTab.id}/interrupt`, { method: 'POST' })
        } catch {}
        // Optimistically update thinking state
        updateThinkingState(false)
      }
      // Small delay so the interrupt lands before we send the next turn
      setTimeout(() => {
        if (activePane) activePane.sendInputWithEcho(text)
        pushHistory(text)
        resetHistoryNav()
        chatInput.focus()
      }, 150)
    })

    banner.querySelector('.cbr-queue-cancel').addEventListener('click', () => {
      dismissQueueBanner()
      chatInput.focus()
    })
  }

  function sendInput() {
    const text = chatInput.value
    if (!text) return

    // Feature 1: when claude is busy on a claude tab, offer queue/interrupt choice
    if (isClaudeTab && isClaudeThinking) {
      // Clear input first so the user can keep typing if they cancel
      chatInput.value = ''
      autoResize()
      hideSuggestions()
      hideSlashCommands()
      showQueueChoiceBanner(text)
      chatInput.focus()
      return
    }

    // Not busy (or not a claude tab): send immediately as before
    if (activePane) activePane.sendInputWithEcho(text)
    pushHistory(text)
    resetHistoryNav()
    hideSuggestions()
    hideSlashCommands()
    chatInput.value = ''
    autoResize()
    chatInput.focus()
  }

  sendBtn.addEventListener('click', sendInput)

  // ── IME composition guard ─────────────────────────────────────────────────
  // Track whether the user is mid-composition (e.g. Chinese/Japanese IME).
  // Some browsers (Chrome on Windows/Mac) set e.isComposing=true during
  // compositionstart..compositionend, but others (older iOS Safari, some
  // Android WebView) only set keyCode 229.  We use a flag + both signals.
  let _isComposing = false
  chatInput.addEventListener('compositionstart', () => { _isComposing = true })
  chatInput.addEventListener('compositionend', () => { _isComposing = false })

  chatInput.addEventListener('input', () => {
    autoResize()
    resetHistoryNav()
    const val = chatInput.value
    // Slash command mode for claude tabs
    if (isClaudeTab && val.startsWith('/')) {
      hideSuggestions()
      showSlashCommands(val.slice(1))
      return
    }
    hideSlashCommands()
    showSuggestions(val)
  })

  chatInput.addEventListener('keydown', (e) => {
    const suggestionsOpen = suggestionsDropdown && !suggestionsDropdown.hidden

    if (e.key === 'Enter' && !e.shiftKey) {
      // Block Enter while IME is composing (handles Chinese/Japanese/Korean input).
      // e.isComposing is standard; keyCode===229 is the legacy fallback used by
      // some older browsers / Android WebViews during composition.
      if (e.isComposing || _isComposing || e.keyCode === 229) return
      e.preventDefault()
      // If slash dropdown is open, pick the first item or close
      if (claudeSlashOpen) {
        const firstItem = suggestionsDropdown?.querySelector('.claude-slash-item')
        if (firstItem) {
          const cmdEl = firstItem.querySelector('.claude-slash-cmd')
          if (cmdEl) {
            chatInput.value = cmdEl.textContent + ' '
            autoResize()
          }
        }
        hideSlashCommands()
        return
      }
      if (suggestionsOpen && selectedSuggestion >= 0) {
        const text = getSelectedSuggestionText()
        if (text) {
          chatInput.value = text
          autoResize()
        }
        hideSuggestions()
        return
      }
      sendInput()
      return
    }

    if (e.key === 'Tab') {
      // Tab cycles bash tabs (Shift+Tab cycles backward). Always intercepted
      // regardless of composer content — explicit user intent per design.
      e.preventDefault()
      hideSuggestions()
      if (tabManager) tabManager.cycle(e.shiftKey ? -1 : 1)
      return
    }

    if (e.key === 'Escape') {
      if (claudeSlashOpen) {
        hideSlashCommands()
      } else if (suggestionsOpen) {
        hideSuggestions()
      } else {
        chatInput.value = ''
        autoResize()
      }
      e.preventDefault()
      return
    }

    if (e.key === 'ArrowUp') {
      e.preventDefault()
      if (suggestionsOpen) {
        selectSuggestion(-1)
        return
      }
      if (!history.length) return
      if (historyIdx === -1) {
        historyDraft = chatInput.value
        historyIdx = history.length - 1
      } else if (historyIdx > 0) {
        historyIdx--
      }
      chatInput.value = history[historyIdx]
      autoResize()
      hideSuggestions()
      return
    }

    if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (suggestionsOpen) {
        selectSuggestion(1)
        return
      }
      if (historyIdx === -1) return
      if (historyIdx < history.length - 1) {
        historyIdx++
        chatInput.value = history[historyIdx]
      } else {
        historyIdx = -1
        chatInput.value = historyDraft
      }
      autoResize()
      hideSuggestions()
      return
    }

    if (e.ctrlKey && e.key === 'c' && !chatInput.value) {
      e.preventDefault()
      if (activePane) activePane.sendRaw('\x03')
      return
    }

    if (e.ctrlKey && e.key === 'l') {
      e.preventDefault()
      if (activePane) activePane.sendRaw('\x0c')
      return
    }
  })

  chatInput.addEventListener('blur', () => {
    setTimeout(() => {
      hideSuggestions()
      hideSlashCommands()
    }, 150)
  })

  // Touch toolbar
  const touchToolbar = document.getElementById('touch-toolbar')
  if (touchToolbar) {
    touchToolbar.addEventListener('click', (e) => {
      const btn = e.target.closest('.touch-btn')
      if (!btn) return
      const action = btn.dataset.action
      if (!activePane) return
      switch (action) {
        case 'ctrl-c':
          activePane.sendRaw('\x03'); break
        case 'ctrl-l':
          activePane.sendRaw('\x0c'); break
        case 'arrow-up': {
          if (!history.length) break
          if (historyIdx === -1) {
            historyDraft = chatInput.value
            historyIdx = history.length - 1
          } else if (historyIdx > 0) historyIdx--
          chatInput.value = history[historyIdx]
          autoResize(); hideSuggestions(); break
        }
        case 'arrow-down': {
          if (historyIdx === -1) break
          if (historyIdx < history.length - 1) {
            historyIdx++; chatInput.value = history[historyIdx]
          } else {
            historyIdx = -1; chatInput.value = historyDraft
          }
          autoResize(); hideSuggestions(); break
        }
        case 'tab':
          activePane.sendRaw('\t'); break
        case 'escape':
          if (suggestionsDropdown && !suggestionsDropdown.hidden) hideSuggestions()
          else { chatInput.value = ''; autoResize() }
          break
      }
      if (document.activeElement === chatInput) chatInput.focus()
    })
  }

  mobileQuery.addEventListener('change', () => fitTerminals())
}

function setupKeyboardShortcuts() {
  document.addEventListener('keydown', (e) => {
    // Ctrl+T: new tab
    if (e.ctrlKey && !e.shiftKey && !e.altKey && (e.key === 't' || e.key === 'T')) {
      e.preventDefault()
      if (tabManager) tabManager.newTab()
      return
    }
    // Ctrl+W: close active tab
    if (e.ctrlKey && !e.shiftKey && !e.altKey && (e.key === 'w' || e.key === 'W')) {
      e.preventDefault()
      if (tabManager && tabManager.activeId) tabManager.closeTab(tabManager.activeId)
      return
    }
    // Ctrl+1..9: jump to tab
    if (e.ctrlKey && !e.shiftKey && !e.altKey && /^[1-9]$/.test(e.key)) {
      e.preventDefault()
      if (tabManager) tabManager.jumpTo(parseInt(e.key, 10))
      return
    }
    // Tab when focus is not in an input: cycle
    if (
      e.key === 'Tab' &&
      document.activeElement?.tagName !== 'INPUT' &&
      document.activeElement?.tagName !== 'TEXTAREA'
    ) {
      e.preventDefault()
      if (tabManager) tabManager.cycle(e.shiftKey ? -1 : 1)
      const chatInput = document.getElementById('chat-input')
      if (chatInput) chatInput.focus()
    }
  })
}

function setupMobile() {
  // Mobile pane switcher — buttons toggle between left (terminal) and right (explorer).
  const switchEl = document.getElementById('mobile-pane-switch')
  if (switchEl) {
    function setMobilePane(pane) {
      document.body.classList.toggle('mobile-pane-left', pane === 'left')
      document.body.classList.toggle('mobile-pane-right', pane === 'right')
      switchEl.querySelectorAll('.mobile-pane-btn').forEach((b) => {
        b.classList.toggle('active', b.dataset.pane === pane)
      })
      if (pane === 'left') fitTerminals()
    }
    switchEl.addEventListener('click', (e) => {
      const btn = e.target.closest('.mobile-pane-btn')
      if (!btn) return
      setMobilePane(btn.dataset.pane)
    })
    // Default to terminal on mobile load
    if (isMobile()) setMobilePane('left')
    mobileQuery.addEventListener('change', () => {
      if (isMobile()) setMobilePane('left')
      else {
        document.body.classList.remove('mobile-pane-left', 'mobile-pane-right')
      }
    })
  }

  if (!isMobile()) return

  // Mobile keyboard handling, lifted verbatim from codebuilder.
  // The mobile media query freezes html/body and lets .app-layout
  // consume `calc(var(--vvh, 100dvh) - 48px)`. We keep --vvh synced
  // to visualViewport.height so the layout shrinks when the soft
  // keyboard opens. killScroll() defangs iOS Safari's habit of
  // scrolling the page upward as the keyboard slides in.
  const chatInput = document.getElementById('chat-input')
  const killScroll = () => {
    window.scrollTo(0, 0)
    document.documentElement.scrollTop = 0
    document.body.scrollTop = 0
  }
  window.addEventListener('scroll', killScroll)
  document.addEventListener('scroll', killScroll)
  if (chatInput) {
    chatInput.addEventListener('focus', () => {
      setTimeout(killScroll, 50)
      setTimeout(killScroll, 150)
      setTimeout(killScroll, 300)
    })
  }
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', () => {
      document.documentElement.style.setProperty(
        '--vvh',
        `${window.visualViewport.height}px`
      )
      killScroll()
    })
    window.visualViewport.addEventListener('scroll', killScroll)
  }

  // --- Swipe to switch between terminal tabs ----------------------
  // Heuristics: single finger, total elapsed < 400 ms, horizontal
  // delta > 60 px AND > 1.8× the vertical delta. That window is wide
  // enough that an intentional flick triggers a switch and narrow
  // enough that long-press + drag (used by mobile browsers for text
  // selection inside xterm) doesn't accidentally cycle tabs.
  const SWIPE_MIN_DX = 60
  const SWIPE_MAX_DT = 400
  const SWIPE_MAX_DY_RATIO = 0.55 // |dy| / |dx| must be below this
  const terminalStack = document.getElementById('terminal-stack')
  if (terminalStack) {
    let startX = 0, startY = 0, startT = 0, touchCount = 0
    terminalStack.addEventListener('touchstart', (e) => {
      touchCount = e.touches.length
      if (touchCount !== 1) return
      const t = e.touches[0]
      startX = t.clientX
      startY = t.clientY
      startT = performance.now()
    }, { passive: true })
    terminalStack.addEventListener('touchend', (e) => {
      if (touchCount !== 1) return
      const t = e.changedTouches[0]
      const dx = t.clientX - startX
      const dy = t.clientY - startY
      const dt = performance.now() - startT
      if (dt > SWIPE_MAX_DT) return
      if (Math.abs(dx) < SWIPE_MIN_DX) return
      if (Math.abs(dy) / Math.abs(dx) > SWIPE_MAX_DY_RATIO) return
      if (!tabManager || tabManager.tabs.length < 2) return
      // Left swipe (dx<0) advances to next tab; right swipe goes back.
      tabManager.cycle(dx < 0 ? 1 : -1)
    }, { passive: true })
  }
}
