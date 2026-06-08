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
      // Create a new claude tab pre-loaded with this sessionId.
      // Pass claudeSessionId in the POST body so the tab is created with the
      // correct session ID immediately — before the WS broadcast causes the
      // ClaudeBlockRenderer to connect and fetch history. This avoids the
      // create+patch two-step race where CBR fetches history with the wrong
      // (freshly-generated) UUID before the PATCH arrives.
      const newTab = await fetch(`/api/projects/${projectId}/tabs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'claude', label: `resume`, claudeSessionId: sessionId }),
      }).then(r => r.json())

      if (newTab?.id) {
        // Always set _pendingActiveId so setActive fires when the WS broadcast
        // arrives (if it hasn't yet). Also call setActive immediately if the tab
        // is already in the local list (WS beat the HTTP response). Both paths
        // must be covered because HTTP response and WS message ordering is not
        // guaranteed.
        tabManager._pendingActiveId = newTab.id
        if (tabManager.projectId === projectId && tabManager.tabs.some(t => t.id === newTab.id)) {
          tabManager._pendingActiveId = null
          tabManager.setActive(newTab.id)
        }
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

// Claude slash commands for the dropdown.
// Populated dynamically from GET /api/claude/slash-commands (which reads the installed
// claude CLI's init event so it's always up-to-date and includes user/plugin commands).
// The fallback list below is used during initial load or when the API is unavailable.
const _SLASH_FALLBACK = [
  { cmd: '/clear',    hint: 'Clear conversation history' },
  { cmd: '/compact',  hint: 'Compact context to reduce token usage' },
  { cmd: '/help',     hint: 'Show help and available commands' },
  { cmd: '/exit',     hint: 'Exit Claude Code' },
  { cmd: '/status',   hint: 'Show session status and info' },
  { cmd: '/resume',   hint: 'Resume previous session' },
  { cmd: '/model',    hint: 'Switch Claude model' },
]

// Hints for well-known commands (used to annotate the dynamic list)
const _SLASH_HINTS = {
  '/clear':         'Clear conversation history',
  '/compact':       'Compact context to reduce token usage',
  '/help':          'Show help and available commands',
  '/exit':          'Exit Claude Code',
  '/status':        'Show session status and info',
  '/restart':       'Restart session',
  '/resume':        'Resume previous session',
  '/add-dir':       'Add working directory to session',
  '/agents':        'List and manage sub-agents',
  '/bug':           'Report a bug to Anthropic',
  '/config':        'Open Claude Code configuration',
  '/context':       'Show current context window usage',
  '/cost':          'Show token cost for this session',
  '/doctor':        'Check Claude Code installation health',
  '/hooks':         'Manage Claude Code hooks',
  '/ide':           'Connect to IDE integration',
  '/init':          'Initialize project with CLAUDE.md',
  '/login':         'Log in to Claude / Anthropic',
  '/logout':        'Log out from Claude',
  '/mcp':           'Manage MCP server connections',
  '/memory':        'Edit Claude memory files',
  '/model':         'Switch Claude model',
  '/permissions':   'Manage tool permissions',
  '/pr-comments':   'Review and reply to PR comments',
  '/release-notes': 'Show recent release notes',
  '/review':        'Review code changes',
  '/settings':      'Edit Claude Code settings',
  '/todos':         'Show and manage TODO items',
  '/vim':           'Toggle vim keybindings mode',
}

let CLAUDE_SLASH_COMMANDS = [..._SLASH_FALLBACK]

// Fetch live slash commands from the server (non-blocking)
fetch('/api/claude/slash-commands')
  .then((r) => r.ok ? r.json() : null)
  .then((data) => {
    if (data && Array.isArray(data.commands) && data.commands.length > 0) {
      CLAUDE_SLASH_COMMANDS = data.commands.map(({ cmd }) => ({
        cmd,
        hint: _SLASH_HINTS[cmd] || '',
      }))
      console.log(`[slash-commands] loaded ${CLAUDE_SLASH_COMMANDS.length} commands from server`)
    }
  })
  .catch(() => { /* keep fallback */ })

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

  // ── Claude tab "Run in Background" button ─────────────────────────────────
  // Visible only while Claude is thinking. Releases the UI without interrupting
  // the server-side turn; the existing turn-complete notification fires when done.
  const bgBtn = document.createElement('button')
  bgBtn.type = 'button'
  bgBtn.id = 'claude-bg-btn'
  bgBtn.className = 'claude-bg-btn'
  bgBtn.setAttribute('aria-label', 'Run in background')
  bgBtn.title = 'Run in background (keep turn running, free the UI)'
  // Layers icon — two stacked rectangles, suggesting "push to back"
  bgBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="7" width="14" height="14" rx="2"/><path d="M8 7V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-2"/></svg>`
  bgBtn.hidden = true
  // Insert before stop-btn (so order is: [bg] [stop] [send])
  stopBtn.parentNode.insertBefore(bgBtn, stopBtn)

  // ── Background turn tracking ──────────────────────────────────────────────
  // Set of tabIds whose turns are running in the background (UI released).
  const _bgTabIds = new Set()

  function _getBgTabId() {
    if (!tabManager) return null
    return tabManager.activeId || null
  }

  /** Push active tab to background: release UI without interrupting server. */
  function doBackground() {
    const tabId = _getBgTabId()
    if (!tabId) return
    _bgTabIds.add(tabId)
    // Release the UI as if thinking ended, but without a real WS result.
    // skipFlush=true: queue must NOT flush — turn is still running server-side.
    chatInput.classList.remove('claude-thinking')
    stopBtn.hidden = true
    bgBtn.hidden = true
    sendBtn.hidden = false
    isClaudeThinking = false
    // Update the tab slot badge so user can see which tab has a bg turn.
    _updateBgBadges()
  }

  /** Clear bg state for a tab (called when its turn completes). */
  function _clearBgTab(tabId) {
    if (!tabId) return
    _bgTabIds.delete(tabId)
    _updateBgBadges()
  }

  /** Refresh the small '·' badge on tab slots that have a background turn. */
  function _updateBgBadges() {
    const track = document.getElementById('tab-slot-track')
    if (!track) return
    for (const slot of track.children) {
      const tid = slot.dataset.tabId
      slot.classList.toggle('has-bg-turn', !!(_bgTabIds.has(tid)))
    }
  }


  // ── Client-side pending queue ─────────────────────────────────────────────
  // Messages typed while Claude is busy are held here (not sent to server yet).
  // When Claude becomes idle, all pending items are combined into one turn.
  // This matches CLI behaviour: silent auto-queue + ↑ to edit last item.
  let _pendingQueue = []
  // Track which (projectId, tabId) the current _pendingQueue belongs to.
  let _queueProjectId = null
  let _queueTabId = null

  // ── Queue persistence helpers ─────────────────────────────────────────────
  // Debounced PUT so rapid mutations (splice loop) only fire one request.
  let _persistTimer = null
  function _schedulePersist() {
    if (!_queueProjectId || !_queueTabId) return
    clearTimeout(_persistTimer)
    _persistTimer = setTimeout(() => {
      const pid = _queueProjectId
      const tid = _queueTabId
      const snapshot = [..._pendingQueue]
      fetch(`/api/projects/${pid}/tabs/${tid}/queue`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ queue: snapshot }),
      }).catch(() => { /* non-fatal */ })
    }, 200)
  }

  async function _hydrateQueue(projectId, tabId) {
    try {
      const r = await fetch(`/api/projects/${projectId}/tabs/${tabId}/queue`)
      if (!r.ok) return
      const data = await r.json()
      if (Array.isArray(data.queue) && data.queue.length > 0) {
        // Only overwrite when the local queue is still empty.  If the user
        // typed a new message while the fetch was in flight we must not clobber
        // it (problem-4 hydrate race).
        if (_pendingQueue.length === 0) {
          _pendingQueue = data.queue
          updateQueueTray()
        }
      }
    } catch { /* non-fatal */ }
  }

  // Inject the queue tray (above .input-row) at init time.
  const queueTray = document.createElement('div')
  queueTray.id = 'claude-queue-tray'
  queueTray.className = 'claude-queue-tray'
  queueTray.hidden = true
  inputRow.parentNode.insertBefore(queueTray, inputRow)

  function updateQueueTray() {
    const visible = _pendingQueue.length > 0 && isClaudeTab
    queueTray.hidden = !visible
    if (!visible) { queueTray.innerHTML = ''; return }
    queueTray.innerHTML =
      `<div class="cq-header">` +
        `<span class="cq-header-label">排队中 (${_pendingQueue.length})</span>` +
        `<button class="cq-send-now" title="Interrupt current turn and send all queued messages immediately">Send now</button>` +
      `</div>` +
      _pendingQueue.map((text, i) => {
        const truncated = text.length > 72 ? text.slice(0, 72) + '…' : text
        return `<div class="cq-item">` +
          `<span class="cq-pos">${i + 1}</span>` +
          `<span class="cq-text">${escapeHtml(truncated)}</span>` +
          `<button class="cq-remove" data-idx="${i}" aria-label="Remove queued message" title="Remove from queue">×</button>` +
          `</div>`
      }).join('') +
      `<div class="cq-hint">↑ 取回编辑 · Claude 空闲时自动发送</div>`
    queueTray.querySelectorAll('.cq-remove').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation()
        _pendingQueue.splice(+btn.dataset.idx, 1)
        _schedulePersist()
        updateQueueTray()
      })
    })
    // "立即发送" button: interrupt current turn then immediately flush pending queue
    const sendNowBtn = queueTray.querySelector('.cq-send-now')
    if (sendNowBtn) {
      sendNowBtn.addEventListener('click', async (e) => {
        e.stopPropagation()
        if (_pendingQueue.length === 0) return
        // Grab all queued messages before interrupting
        const all = _pendingQueue.splice(0)
        _schedulePersist()
        updateQueueTray()
        // Interrupt the current turn, then wait for the result event (thinking=false)
        // before sending so the backend is idle and ready for the new turn.
        const combined = all.join('\n\n')
        let sent = false
        const doSend = () => {
          if (sent) return
          sent = true
          if (activePane) activePane.sendInputWithEcho(combined)
          pushHistory(combined)
          resetHistoryNav()
          chatInput.focus()
        }
        // One-shot listener: fires when Claude goes idle after the interrupt
        const onIdle = (ev) => {
          const detail = ev.detail || {}
          const activeId = tabManager ? tabManager.activeId : null
          if (activeId && detail.tabId !== activeId) return  // wrong tab
          if (detail.thinking) return  // still thinking
          document.removeEventListener('nanocode:claude-thinking', onIdle)
          doSend()
        }
        document.addEventListener('nanocode:claude-thinking', onIdle)
        // Interrupt the current turn (fires SIGINT → triggers WS result event → onIdle)
        await doInterrupt()
        // Safety fallback: if the result event never fires within 3s, send anyway
        setTimeout(() => {
          document.removeEventListener('nanocode:claude-thinking', onIdle)
          doSend()
        }, 3000)
      })
    }
  }

  // ── State ─────────────────────────────────────────────────────────────────
  let isClaudeTab = false      // is the active tab a claude tab?
  let isCodexTab = false       // is the active tab a codex tab? (N43: slash passthrough)
  let isClaudeThinking = false // is claude currently thinking?
  let isCodexThinking = false  // is codex currently thinking? (P2: visual feedback)
  let claudeSlashOpen = false  // is the slash commands dropdown open?

  function updateInputBarForTabType({ skipFlush = false } = {}) {
    const tabType = _activeTabType
    isClaudeTab = tabType === 'claude'
    isCodexTab = tabType === 'codex'
    if (isClaudeTab) {
      chatInput.placeholder = 'Message Claude… (/ for commands)'
    } else if (isCodexTab) {
      // N43: codex tab — "/" should pass through to codex, not trigger nanocode slash menu
      chatInput.placeholder = 'Send to Codex… (/ for codex commands)'
    } else {
      chatInput.placeholder = 'Type a command...'
    }
    // Stop btn only visible when claude is thinking
    updateThinkingState(isClaudeThinking && isClaudeTab, { skipFlush })
  }

  function updateThinkingState(thinking, { skipFlush = false } = {}) {
    isClaudeThinking = thinking
    const activeTabId = tabManager ? tabManager.activeId : null
    const isActiveBg = activeTabId && _bgTabIds.has(activeTabId)
    if (isClaudeTab && thinking && !isActiveBg) {
      chatInput.classList.add('claude-thinking')
      // Restore stop button to default icon/state
      stopBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>`
      stopBtn.title = 'Stop Claude (interrupt)'
      stopBtn.disabled = false
      stopBtn.hidden = false
      bgBtn.hidden = false
      sendBtn.hidden = true
    } else {
      chatInput.classList.remove('claude-thinking')
      // Result arrived — restore normal send UI.
      stopBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>`
      stopBtn.title = 'Stop Claude (interrupt)'
      stopBtn.disabled = false
      stopBtn.hidden = true
      bgBtn.hidden = true
      sendBtn.hidden = false
      // Auto-flush: when Claude becomes idle, send all pending queued messages
      // as one combined turn (matches CLI "send all at once when idle" behaviour).
      // skipFlush=true when called from nanocode:tab-active to prevent premature
      // flush — flush must only happen on a real WS result event (b67a2b6, P0).
      if (!thinking && isClaudeTab && _pendingQueue.length > 0 && !skipFlush) {
        const all = _pendingQueue.splice(0)
        _schedulePersist()
        updateQueueTray()
        const combined = all.join('\n\n')
        if (activePane) activePane.sendInputWithEcho(combined)
        pushHistory(combined)
        resetHistoryNav()
      }
    }
  }

  // Listen for tab switches
  const origOnActiveChange = tabManager ? null : null  // will hook via event
  document.addEventListener('nanocode:tab-active', (e) => {
    _activeTabType = e.detail?.type || 'bash'

    // Hydrate the pending queue from the backend when switching to a claude tab.
    // Must happen BEFORE isClaudeThinking reset + updateInputBarForTabType() to
    // prevent a stale _pendingQueue from being flushed while Claude is still busy
    // on the target tab (P0 queue-flush race, problem-3).
    const newTabId = e.detail?.tabId || null
    const newProjectId = currentProjectId
    const switchedTab = newTabId !== _queueTabId || newProjectId !== _queueProjectId
    if (switchedTab) {
      // Clear in-memory queue FIRST so updateThinkingState() (called below via
      // updateInputBarForTabType) cannot see a stale queue and flush it prematurely.
      _pendingQueue = []
      _queueProjectId = newProjectId
      _queueTabId = newTabId
    }

    isClaudeThinking = false  // reset on tab switch
    isCodexThinking = false
    // Reset codex-thinking CSS state on tab switch
    chatInput.classList.remove('codex-thinking')
    sendBtn.classList.remove('codex-thinking-btn')
    sendBtn.disabled = false
    // skipFlush=true: do NOT flush _pendingQueue on tab-switch — flush must only
    // happen when the WS 'result' event arrives confirming Claude is truly idle.
    updateInputBarForTabType({ skipFlush: true })

    // If switching to a claude tab that was sent to background and is still running,
    // restore the thinking UI (stop + bg buttons) so the user can interact again.
    if (newTabId && _activeTabType === 'claude' && _bgTabIds.has(newTabId)) {
      const tabEntry = tabManager ? tabManager.tabs.find((t) => t.id === newTabId) : null
      const pane = tabEntry?.pane
      const stillRunning = pane && typeof pane.isThinking === 'function' && pane.isThinking()
      if (stillRunning) {
        // Re-enter foreground thinking UI without clearing bg flag yet.
        // The bg flag will be cleared when the WS result event (thinking=false) arrives.
        chatInput.classList.add('claude-thinking')
        stopBtn.hidden = false
        bgBtn.hidden = false
        sendBtn.hidden = true
        isClaudeThinking = true
      } else {
        // Turn already completed while in bg — clean up the stale bg flag.
        _clearBgTab(newTabId)
      }
    }

    // Start async hydrate AFTER the sync flush-guard above.  _hydrateQueue will
    // only overwrite _pendingQueue when it is still empty (problem-4 hydrate race).
    if (switchedTab && _activeTabType === 'claude' && newProjectId && newTabId) {
      _hydrateQueue(newProjectId, newTabId)
    }

    updateQueueTray()           // then update tray with fresh isClaudeTab
    _updateBgBadges()         // refresh background-turn badges on tab slots
  })

  // Listen for claude/codex thinking state changes
  document.addEventListener('nanocode:claude-thinking', (e) => {
    const detail = e.detail || {}
    const thinkingTabId = detail.tabId
    // When a bg turn finishes (thinking=false on any tab), clear its bg state.
    if (!detail.thinking && thinkingTabId) {
      _clearBgTab(thinkingTabId)
    }
    // Only update UI if this is the active tab
    const activeId = tabManager ? tabManager.activeId : null
    if (!activeId || thinkingTabId !== activeId) return
    if (isCodexTab) {
      // N43-R9: codex is an interactive REPL — dim animation only, do NOT
      // disable the send button or the user can't navigate interactive menus
      // (/model, /compact, etc.) or send /clear while codex is busy.
      isCodexThinking = !!detail.thinking
      chatInput.classList.toggle('codex-thinking', isCodexThinking)
      sendBtn.classList.toggle('codex-thinking-btn', isCodexThinking)
      // sendBtn.disabled intentionally NOT set for codex tabs — keep enabled
      sendBtn.title = isCodexThinking ? 'Codex is working… (send to interact)' : 'Send'
    } else {
      updateThinkingState(!!detail.thinking)
    }
  })

  // Listen for subagent-phase transitions.
  // When the main Claude turn has handed off to a subagent (Task tool) and is now
  // idle-waiting, active=true. The outer turn is still in progress (isClaudeThinking
  // stays true so new messages go to the pending queue), but the main model is NOT
  // generating — so we show Send instead of Stop, letting the user queue/chat freely.
  // When active=false the main agent is generating again → Stop/Bg buttons return.
  document.addEventListener('nanocode:claude-subagent-phase', (e) => {
    const detail = e.detail || {}
    const phaseTabId = detail.tabId
    const activeId = tabManager ? tabManager.activeId : null
    if (!activeId || phaseTabId !== activeId) return
    if (!isClaudeTab) return
    const isActiveBg = activeId && _bgTabIds.has(activeId)
    if (isActiveBg) return  // bg turns: no UI change needed
    if (detail.active) {
      // Subagent phase: main agent idle, subagent running.
      // Show Send so user can type/queue; keep isClaudeThinking=true so messages queue.
      chatInput.classList.remove('claude-thinking')
      stopBtn.hidden = true
      bgBtn.hidden = true
      sendBtn.hidden = false
    } else {
      // Main agent resumed generating → restore thinking UI
      if (isClaudeThinking) {
        chatInput.classList.add('claude-thinking')
        stopBtn.hidden = false
        bgBtn.hidden = false
        sendBtn.hidden = true
      }
    }
  })

  // ── Interrupt helper (shared by Stop btn, Esc, Ctrl+C) ─────────────────────
  // Single Esc interrupts the current turn, same as the Claude CLI. Posts
  // /interrupt to the backend (SIGINT). Does NOT call updateThinkingState(false)
  // — that only happens when the WS 'result' event arrives, preserving the
  // _pendingQueue protection (b67a2b6).
  async function doInterrupt() {
    if (!tabManager) return
    const activeTab = tabManager.tabs?.find((t) => t.id === tabManager.activeId)
    if (!activeTab) return
    const projectId = tabManager.projectId
    const tabId = activeTab.id

    try {
      await fetch(`/api/projects/${projectId}/tabs/${tabId}/interrupt`, { method: 'POST' })
    } catch {}

    // Do NOT call showInterruptBlock() here — CLI will emit result/error_during_execution
    // via stdout which nanocode transparently forwards. Let the WS event drive UI state.

    // Visual: keep stopBtn visible until the real WS result event triggers
    // updateThinkingState(false). Do NOT hide stopBtn or show sendBtn yet —
    // this prevents premature flush of _pendingQueue.
    chatInput.classList.remove('claude-thinking')
    stopBtn.disabled = false
    stopBtn.hidden = false
    bgBtn.hidden = true   // bg button not needed once user chose to interrupt
    sendBtn.hidden = true
  }

  // Stop button click: POST interrupt to backend
  stopBtn.addEventListener('click', () => {
    doInterrupt()
  })

  // Background button click: release UI without interrupting server turn
  bgBtn.addEventListener('click', () => {
    doBackground()
  })

  // Expose doInterrupt so Esc/Ctrl+C handlers below can call it.
  // (All three handlers are in the same setupChatInput() closure scope.)

  // ── Slash-command dropdown for Claude tabs ────────────────────────────────

  /**
   * Fuzzy match score: returns a number (lower = better) or -1 for no match.
   * Uses a contiguous-subsequence matching strategy similar to VS Code Cmd+P:
   * all query chars must appear in order in the target, but don't need to be adjacent.
   * Bonus for: consecutive matches, prefix match, word-boundary match.
   */
  function _slashFuzzyScore(target, query) {
    if (!query) return 0  // empty query matches everything, score 0
    const t = target.toLowerCase()
    const q = query.toLowerCase()

    // Fast path: prefix match scores best
    if (t.startsWith(q)) return 0 - q.length

    let ti = 0, qi = 0
    let score = 0
    let consecutive = 0
    while (ti < t.length && qi < q.length) {
      if (t[ti] === q[qi]) {
        score += consecutive > 0 ? -2 : 1   // bonus for consecutive
        consecutive++
        qi++
      } else {
        consecutive = 0
        score += 2  // penalty for gap
      }
      ti++
    }
    if (qi < q.length) return -1  // not all chars matched
    return score
  }

  /**
   * Build grouped slash command list: { builtin: [...], plugins: { name: [...] } }
   * Plugin commands have format "plugin:command", builtins have no colon.
   */
  function _groupSlashCommands(cmds) {
    const builtin = []
    const plugins = {}
    for (const cmd of cmds) {
      const name = cmd.cmd.slice(1)  // strip leading /
      const colonIdx = name.indexOf(':')
      if (colonIdx < 0) {
        builtin.push(cmd)
      } else {
        const pluginName = name.slice(0, colonIdx)
        if (!plugins[pluginName]) plugins[pluginName] = []
        plugins[pluginName].push(cmd)
      }
    }
    return { builtin, plugins }
  }

  function showSlashCommands(query) {
    if (!isClaudeTab) return
    // query is the text after '/', e.g. '' or 'cl' or 'help'
    const q = query.toLowerCase()

    let matches
    if (!q) {
      // No query: show all commands, grouped
      matches = CLAUDE_SLASH_COMMANDS.map((c) => ({ cmd: c, score: 0, matchRanges: [] }))
    } else {
      // Fuzzy filter: match against command name (without leading /)
      const scored = []
      for (const cmd of CLAUDE_SLASH_COMMANDS) {
        const target = cmd.cmd.slice(1)  // command name without /
        const score = _slashFuzzyScore(target, q)
        if (score >= 0) scored.push({ cmd, score })
      }
      if (!scored.length) {
        hideSlashCommands()
        return
      }
      // Sort: lower score = better match
      scored.sort((a, b) => a.score - b.score)
      matches = scored.map(({ cmd, score }) => ({ cmd, score, matchRanges: [] }))
    }

    claudeSlashOpen = true
    suggestionsDropdown.innerHTML = ''

    // Determine highlight ranges for query in cmd text
    function highlightCmd(cmdText, q) {
      if (!q) return escapeHtml(cmdText)
      // Find character positions matching query (greedy left-to-right)
      const t = cmdText.toLowerCase()
      const ql = q.toLowerCase()
      const positions = new Set()
      let qi = 0
      for (let ti = 0; ti < t.length && qi < ql.length; ti++) {
        if (t[ti] === ql[qi]) { positions.add(ti); qi++ }
      }
      let html = ''
      for (let i = 0; i < cmdText.length; i++) {
        const ch = escapeHtml(cmdText[i])
        html += positions.has(i) ? `<mark class="slash-match">${ch}</mark>` : ch
      }
      return html
    }

    function appendItem(opt) {
      const item = document.createElement('div')
      item.className = 'suggestion-item claude-slash-item'
      const cmdDisplay = opt.cmd.cmd
      const hintDisplay = opt.cmd.hint || ''
      const cmdHtml = q ? highlightCmd(cmdDisplay, q) : escapeHtml(cmdDisplay)
      item.innerHTML =
        `<span class="claude-slash-cmd">${cmdHtml}</span>` +
        (hintDisplay ? `<span class="claude-slash-hint">${escapeHtml(hintDisplay)}</span>` : '')
      item.addEventListener('mousedown', (e) => {
        e.preventDefault()
        chatInput.value = cmdDisplay + ' '
        autoResize()
        hideSlashCommands()
        chatInput.focus()
      })
      suggestionsDropdown.appendChild(item)
    }

    function appendGroupHeader(label) {
      const header = document.createElement('div')
      header.className = 'claude-slash-group-header'
      header.textContent = label
      suggestionsDropdown.appendChild(header)
    }

    if (q) {
      // Filtered mode: flat sorted list (no group headers — query breaks grouping intent)
      for (const m of matches) appendItem(m)
    } else {
      // Unfiltered mode: show grouped
      const { builtin, plugins } = _groupSlashCommands(CLAUDE_SLASH_COMMANDS)

      if (builtin.length) {
        appendGroupHeader('Built-in')
        for (const cmd of builtin) appendItem({ cmd, score: 0 })
      }

      for (const [pluginName, cmds] of Object.entries(plugins).sort(([a], [b]) => a.localeCompare(b))) {
        appendGroupHeader(pluginName + ':')
        for (const cmd of cmds) appendItem({ cmd, score: 0 })
      }
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

    // When Claude is busy: silently add to client-side pending queue.
    // No per-message banner — matches CLI behaviour of auto-queuing with a
    // compact tray showing position. User can ↑ to take back the last item,
    // or click × on any item to remove it. All items flush automatically when
    // Claude finishes. To interrupt instead, use the Stop button.
    if (isClaudeTab && isClaudeThinking) {
      _pendingQueue.push(text)
      _schedulePersist()
      chatInput.value = ''
      autoResize()
      hideSuggestions()
      hideSlashCommands()
      updateQueueTray()
      chatInput.focus()
      return
    }

    // N43-R9: Codex is an interactive REPL — do NOT block sends while thinking.
    // The user must be able to send follow-up input (e.g. navigate /model menu,
    // send /clear to interrupt, enter numbers to select options). Removing this
    // guard is the core fix for N43: mobile users were permanently locked out
    // when isCodexThinking=true blocked both the send button AND pointer events.

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

  // ── Compact context button ────────────────────────────────────────────────
  // Sends /compact to the active pane (works for both claude and codex tabs).
  const compactCtxBtn = document.getElementById('compact-ctx-btn')
  if (compactCtxBtn) {
    compactCtxBtn.addEventListener('click', () => {
      if (activePane) activePane.sendInputWithEcho('/compact')
    })
  }

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
    // N43: codex tab — suppress history suggestion dropdown so "/" passes
    // through cleanly to codex without nanocode dropdown intercepting Enter.
    if (isCodexTab) {
      hideSuggestions()
      return
    }
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
        // Priority 1: close slash dropdown
        hideSlashCommands()
      } else if (suggestionsOpen) {
        // Priority 2: close suggestions
        hideSuggestions()
      } else if (isClaudeTab && isClaudeThinking) {
        // Priority 3 (claude tab): interrupt running turn
        doInterrupt()
      } else if (chatInput.value) {
        // Priority 4: clear input
        chatInput.value = ''
        autoResize()
      } else if (!isClaudeTab && activePane) {
        // Bash/codex tab: send raw Escape to PTY
        activePane.sendRaw('\x1b')
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
      // ↑ on empty input with pending queue → pop last item back into input for editing.
      // Mirrors CLI "press up to edit queued messages" behaviour.
      if (isClaudeTab && _pendingQueue.length > 0 && chatInput.value === '') {
        chatInput.value = _pendingQueue.pop()
        _schedulePersist()
        updateQueueTray()
        autoResize()
        chatInput.setSelectionRange(chatInput.value.length, chatInput.value.length)
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

    if (e.ctrlKey && e.key === 'c') {
      e.preventDefault()
      if (chatInput.value) {
        // Input has text: CLI behaviour = clear the line (not copy/kill)
        chatInput.value = ''
        autoResize()
      } else if (isClaudeTab && isClaudeThinking) {
        // Empty + busy on claude tab: interrupt
        doInterrupt()
      } else if (activePane) {
        // Empty + idle, or non-claude tab: forward raw Ctrl+C to PTY
        activePane.sendRaw('\x03')
      }
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
          // Same logic as keyboard Ctrl+C: clear input if has text, else interrupt/sendRaw
          if (chatInput.value) {
            chatInput.value = ''; autoResize()
          } else if (isClaudeTab && isClaudeThinking) {
            doInterrupt()
          } else {
            activePane.sendRaw('\x03')
          }
          break
        case 'ctrl-l':
          activePane.sendRaw('\x0c'); break
        case 'arrow-up': {
          // Same as keyboard ↑: pop pending queue first if applicable
          if (isClaudeTab && _pendingQueue.length > 0 && chatInput.value === '') {
            chatInput.value = _pendingQueue.pop()
            _schedulePersist()
            updateQueueTray()
            autoResize()
            break
          }
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
          // Same priority logic as keyboard Esc
          if (claudeSlashOpen) {
            hideSlashCommands()
          } else if (suggestionsOpen) {
            hideSuggestions()
          } else if (isClaudeTab && isClaudeThinking) {
            doInterrupt()
          } else if (chatInput.value) {
            chatInput.value = ''; autoResize()
          } else if (!isClaudeTab) {
            activePane.sendRaw('\x1b')
          }
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
