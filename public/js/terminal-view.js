/**
 * Terminal view — manages bash + claude panes, sessions, unified input.
 *
 * Adapted from terminal/public/js/app.js for the unified frontend.
 * Created lazily on first terminal tab visit.
 */

import { TerminalPane } from './terminal-pane.js'
import { initSplitPane } from './split-pane.js'
import { fetchDiskSessions, fetchRunningSessions, deleteClaudeSession as apiDeleteSession, archiveSession as apiArchiveSession, unarchiveSession as apiUnarchiveSession, fetchArchivedSessions, markSessionManaged, fetchManagedDiskSessions } from './api.js'
import { state } from './state.js'

const mobileQuery = window.matchMedia('(max-width: 768px)')
const isMobile = () => mobileQuery.matches

let initialized = false
let bashPane = null
let claudePane = null
let diskSessions = []
let runningSessions = []
let activeSessionId = null
let newSessionCounter = 0
let currentProjectId = null

// Mode toggle state
let activeMode = 'bash'

// Managed-only filter state (persisted in localStorage)
let managedOnly = false
try { managedOnly = localStorage.getItem('sessionManagedOnly') === '1' } catch {}

const statusBash = document.getElementById('status-bash')
const statusClaude = document.getElementById('status-claude')

function setStatus(el, label, connected) {
  if (!el) return
  el.textContent = `${label}: ${connected ? 'connected' : 'disconnected'}`
  el.classList.toggle('connected', connected)
}

/**
 * Initialize the terminal view for a given project.
 * Called on first terminal tab visit, or when project changes.
 *
 * @param {string} projectId
 */
export async function initTerminalView(projectId) {
  if (!projectId) return
  currentProjectId = projectId

  if (!initialized) {
    initialized = true
    setupSplitPane()
    setupModeToggle()
    setupSessionButtons()
    setupMobile()
  }

  // Fetch disk sessions to know which session to start with
  diskSessions = await fetchDiskSessions(projectId).catch(() => [])
  activeSessionId = diskSessions.length ? diskSessions[0].sessionId : null

  createPanes(projectId)
  fetchAndRenderSessions(projectId)
}

/**
 * Switch the terminal view to a new project.
 * @param {string} projectId
 */
export function switchTerminalProject(projectId) {
  if (!projectId || !initialized) return
  currentProjectId = projectId
  activeSessionId = null

  if (bashPane) bashPane.switchProject(projectId)
  if (claudePane) claudePane.switchProject(projectId)
  fetchAndRenderSessions(projectId)
}

/**
 * Re-fit terminal panes (call when terminal tab becomes visible).
 */
export function fitTerminals() {
  if (bashPane) requestAnimationFrame(() => bashPane.fitAddon.fit())
  if (claudePane) requestAnimationFrame(() => claudePane.fitAddon.fit())
}

/**
 * Whether the terminal view has been initialized.
 */
export function isInitialized() {
  return initialized
}

/**
 * Update pane header label and mode toggle button text based on current cliProvider.
 * Called when settings change via WebSocket.
 */
export function updateProviderLabels() {
  const provider = state.cliProvider
  const label = provider === 'agent' ? 'Cursor Agent' : 'Claude Code'

  // Update pane header label
  const headerLabel = document.querySelector('.pane-right .pane-header-label')
  if (headerLabel) headerLabel.textContent = label

  // Update mode toggle button text (preserve the SVG icon)
  const modeClaudeBtn = document.getElementById('mode-claude')
  if (modeClaudeBtn) {
    const shortLabel = provider === 'agent' ? 'Agent' : 'Claude'
    const textNodes = Array.from(modeClaudeBtn.childNodes).filter(n => n.nodeType === Node.TEXT_NODE)
    const lastText = textNodes[textNodes.length - 1]
    if (lastText) lastText.textContent = '\n                ' + shortLabel + '\n              '
  }

  // Update claude pane's cliProvider for next connection
  if (claudePane) claudePane.cliProvider = provider
}

/**
 * Open a Claude session in the terminal view.
 * If claudeSessionId is provided, resumes that session; otherwise creates a fresh one.
 *
 * @param {string} [claudeSessionId] — optional SDK session UUID to resume
 */
export function openNewClaudeSession(claudeSessionId) {
  if (!initialized) return
  const newId = claudeSessionId || ('new-' + newSessionCounter++)
  activeSessionId = newId
  if (claudePane) claudePane.switchSession(newId)
  if (currentProjectId) {
    fetchRunningSessions(currentProjectId).then(running => {
      runningSessions = running
      renderSessionTabs()
    }).catch(() => {})
  }
}

// --- Internal functions ---

function createPanes(projectId) {
  const bashContainer = document.getElementById('terminal-bash')
  const claudeContainer = document.getElementById('terminal-claude')
  if (!bashContainer || !claudeContainer) return

  if (bashPane) bashPane.dispose()
  if (claudePane) claudePane.dispose()

  bashPane = new TerminalPane(bashContainer, {
    projectId,
    sessionType: 'bash',
    onStatusChange: (c) => setStatus(statusBash, 'Bash', c),
  })
  claudePane = new TerminalPane(claudeContainer, {
    projectId,
    sessionType: 'claude',
    claudeSessionId: activeSessionId || '',
    cliProvider: state.cliProvider,
    onStatusChange: (c) => setStatus(statusClaude, 'Claude', c),
  })
}

// --- Session management ---

async function fetchAndRenderSessions(projectId) {
  const fetchDisk = managedOnly ? fetchManagedDiskSessions : fetchDiskSessions
  const [disk, running] = await Promise.all([
    fetchDisk(projectId).catch(() => []),
    fetchRunningSessions(projectId).catch(() => []),
  ])
  diskSessions = disk
  runningSessions = running

  if (!activeSessionId && diskSessions.length) {
    activeSessionId = diskSessions[0].sessionId
    if (claudePane) claudePane.switchSession(activeSessionId)
  }

  renderSessionTabs()
}

function updateScrollButtons() {
  const tabsEl = document.getElementById('session-tabs')
  const scrollLeft = document.getElementById('session-scroll-left')
  const scrollRight = document.getElementById('session-scroll-right')
  if (!tabsEl || !scrollLeft || !scrollRight) return
  const overflows = tabsEl.scrollWidth > tabsEl.clientWidth + 1
  scrollLeft.hidden = !overflows || tabsEl.scrollLeft <= 0
  scrollRight.hidden = !overflows || tabsEl.scrollLeft >= tabsEl.scrollWidth - tabsEl.clientWidth - 1
}

function truncate(text, maxLen = 24) {
  if (!text) return ''
  return text.length > maxLen ? text.slice(0, maxLen) + '...' : text
}

function renderSessionTabs() {
  const sessionTabsEl = document.getElementById('session-tabs')
  if (!sessionTabsEl) return
  sessionTabsEl.textContent = ''

  const allSessions = []
  const diskIds = new Set(diskSessions.map(s => s.sessionId))

  for (const s of diskSessions) {
    allSessions.push({
      id: s.sessionId,
      label: s.slug || truncate(s.preview) || s.sessionId.slice(0, 8),
      isRunning: runningSessions.includes(s.sessionId),
    })
  }

  for (const id of runningSessions) {
    if (!diskIds.has(id) && id.startsWith('new-')) {
      allSessions.push({ id, label: 'New session', isRunning: true })
    }
  }

  for (const session of allSessions) {
    const tab = document.createElement('button')
    tab.className = 'session-tab' + (session.id === activeSessionId ? ' active' : '')
    tab.type = 'button'
    tab.dataset.sessionId = session.id

    if (session.isRunning) {
      const dot = document.createElement('span')
      dot.className = 'session-tab-dot'
      tab.appendChild(dot)
    }

    const label = document.createElement('span')
    label.className = 'session-tab-label'
    label.textContent = session.label
    tab.appendChild(label)

    tab.addEventListener('click', () => switchClaudeSession(session.id))

    // Archive button (only for real disk sessions, not new- sessions)
    if (!session.id.startsWith('new-')) {
      const archiveBtn = document.createElement('span')
      archiveBtn.className = 'session-tab-archive'
      archiveBtn.innerHTML = '&#8615;'
      archiveBtn.title = 'Archive session'
      archiveBtn.addEventListener('click', (e) => {
        e.stopPropagation()
        doArchiveSession(session.id)
      })
      tab.appendChild(archiveBtn)
    }

    if (session.isRunning) {
      const closeBtn = document.createElement('span')
      closeBtn.className = 'session-tab-close'
      closeBtn.textContent = '\u00d7'
      closeBtn.addEventListener('click', (e) => {
        e.stopPropagation()
        deleteSession(session.id)
      })
      tab.appendChild(closeBtn)
    }

    sessionTabsEl.appendChild(tab)
  }

  // Scroll active tab into view and update scroll button visibility
  requestAnimationFrame(() => {
    const activeTab = sessionTabsEl.querySelector('.session-tab.active')
    if (activeTab) activeTab.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    updateScrollButtons()
  })
}

function switchClaudeSession(sessionId) {
  if (sessionId === activeSessionId) return
  activeSessionId = sessionId
  if (claudePane) claudePane.switchSession(sessionId)
  // Mark as managed when user explicitly switches to it
  if (currentProjectId && !sessionId.startsWith('new-')) {
    markSessionManaged(currentProjectId, sessionId).catch(() => {})
  }
  renderSessionTabs()
}

async function createClaudeSession() {
  const newId = 'new-' + newSessionCounter++
  activeSessionId = newId
  if (claudePane) claudePane.switchSession(newId)
  if (currentProjectId) {
    runningSessions = await fetchRunningSessions(currentProjectId).catch(() => [])
    renderSessionTabs()
  }
}

async function deleteSession(sessionId) {
  if (!currentProjectId) return
  await apiDeleteSession(currentProjectId, sessionId)

  if (sessionId === activeSessionId) {
    const next = diskSessions.find(s => s.sessionId !== sessionId)
      || runningSessions.find(id => id !== sessionId)
    activeSessionId = next?.sessionId || next || null
    if (claudePane && activeSessionId) claudePane.switchSession(activeSessionId)
  }

  await fetchAndRenderSessions(currentProjectId)
}

// --- Managed filter ---

function toggleManagedFilter() {
  managedOnly = !managedOnly
  try { localStorage.setItem('sessionManagedOnly', managedOnly ? '1' : '0') } catch {}
  const btn = document.getElementById('session-managed-btn')
  if (btn) btn.classList.toggle('active', managedOnly)
  if (currentProjectId) fetchAndRenderSessions(currentProjectId)
}

// --- Archive management ---

async function doArchiveSession(sessionId) {
  if (!currentProjectId) return
  await apiArchiveSession(currentProjectId, sessionId)

  if (sessionId === activeSessionId) {
    const next = diskSessions.find(s => s.sessionId !== sessionId)
      || runningSessions.find(id => id !== sessionId)
    activeSessionId = next?.sessionId || next || null
    if (claudePane && activeSessionId) claudePane.switchSession(activeSessionId)
  }

  await fetchAndRenderSessions(currentProjectId)
  // Refresh archive panel if open
  const panel = document.getElementById('session-archive-panel')
  if (panel && !panel.hidden) renderArchivePanel()
}

async function doUnarchiveSession(sessionId) {
  if (!currentProjectId) return
  await apiUnarchiveSession(currentProjectId, sessionId)
  await fetchAndRenderSessions(currentProjectId)
  renderArchivePanel()
}

function toggleArchivePanel() {
  const panel = document.getElementById('session-archive-panel')
  if (!panel) return
  panel.hidden = !panel.hidden
  if (!panel.hidden) renderArchivePanel()
}

function timeAgo(ts) {
  if (!ts) return ''
  const diff = Date.now() - ts
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

async function renderArchivePanel() {
  const panel = document.getElementById('session-archive-panel')
  if (!panel || !currentProjectId) return

  const archived = await fetchArchivedSessions(currentProjectId)
  panel.innerHTML = ''

  if (!archived.length) {
    const empty = document.createElement('div')
    empty.className = 'archive-empty'
    empty.textContent = 'No archived sessions'
    panel.appendChild(empty)
    return
  }

  for (const s of archived) {
    const item = document.createElement('div')
    item.className = 'archive-item'

    const label = document.createElement('span')
    label.className = 'archive-item-label'
    label.textContent = s.slug || truncate(s.preview) || s.sessionId.slice(0, 8)
    item.appendChild(label)

    const time = document.createElement('span')
    time.className = 'archive-item-time'
    time.textContent = timeAgo(s.lastActivity)
    item.appendChild(time)

    const restoreBtn = document.createElement('button')
    restoreBtn.className = 'archive-item-restore'
    restoreBtn.textContent = 'Unarchive'
    restoreBtn.addEventListener('click', () => doUnarchiveSession(s.sessionId))
    item.appendChild(restoreBtn)

    panel.appendChild(item)
  }
}

// --- Setup functions (called once) ---

function setupSplitPane() {
  initSplitPane(
    document.getElementById('split-container'),
    document.getElementById('split-divider')
  )
}

function setupSessionButtons() {
  const addBtn = document.getElementById('session-add-btn')
  if (addBtn) addBtn.addEventListener('click', createClaudeSession)

  const archiveBtn = document.getElementById('session-archive-btn')
  if (archiveBtn) archiveBtn.addEventListener('click', toggleArchivePanel)

  const managedBtn = document.getElementById('session-managed-btn')
  if (managedBtn) {
    managedBtn.addEventListener('click', toggleManagedFilter)
    managedBtn.classList.toggle('active', managedOnly)
  }

  const drawerBtn = document.getElementById('session-drawer-btn')
  if (drawerBtn) drawerBtn.addEventListener('click', openSessionDrawer)

  const backdrop = document.getElementById('session-drawer-backdrop')
  if (backdrop) backdrop.addEventListener('click', closeSessionDrawer)

  // Scroll buttons for tab overflow
  const tabsEl = document.getElementById('session-tabs')
  const scrollLeft = document.getElementById('session-scroll-left')
  const scrollRight = document.getElementById('session-scroll-right')
  if (tabsEl && scrollLeft && scrollRight) {
    scrollLeft.addEventListener('click', () => { tabsEl.scrollLeft -= 120 })
    scrollRight.addEventListener('click', () => { tabsEl.scrollLeft += 120 })
    tabsEl.addEventListener('scroll', updateScrollButtons)
    new ResizeObserver(updateScrollButtons).observe(tabsEl)
  }
}

function setupModeToggle() {
  const modeBashBtn = document.getElementById('mode-bash')
  const modeClaudeBtn = document.getElementById('mode-claude')
  const modeIndicator = document.getElementById('mode-indicator')
  const chatInput = document.getElementById('chat-input')
  const sendBtn = document.getElementById('send-btn')
  const suggestionsDropdown = document.getElementById('suggestions-dropdown')

  if (!modeBashBtn || !modeClaudeBtn || !modeIndicator || !chatInput || !sendBtn) return

  const panes = {
    bash: { pane: () => bashPane, el: document.querySelector('.pane-left') },
    claude: { pane: () => claudePane, el: document.querySelector('.pane-right') },
  }

  // Command history
  const HISTORY_KEY = 'cmdHistory'
  const MAX_HISTORY = 200

  function loadHistory() {
    try {
      const raw = localStorage.getItem(HISTORY_KEY)
      if (raw) {
        const parsed = JSON.parse(raw)
        return {
          bash: Array.isArray(parsed.bash) ? parsed.bash : [],
          claude: Array.isArray(parsed.claude) ? parsed.claude : [],
        }
      }
    } catch {}
    return { bash: [], claude: [] }
  }

  function saveHistory() {
    try { localStorage.setItem(HISTORY_KEY, JSON.stringify(history)) } catch {}
  }

  const history = loadHistory()
  let historyIdx = -1
  let historyDraft = ''
  let selectedSuggestion = -1

  function pushHistory(text) {
    const list = history[activeMode]
    if (list.length && list[list.length - 1] === text) return
    list.push(text)
    if (list.length > MAX_HISTORY) list.splice(0, list.length - MAX_HISTORY)
    saveHistory()
  }

  function resetHistoryNav() {
    historyIdx = -1
    historyDraft = ''
  }

  // Suggestions
  function showSuggestions(query) {
    if (!suggestionsDropdown || !query.trim()) { hideSuggestions(); return }
    const q = query.toLowerCase()
    const seen = new Set()
    const matches = []
    for (const mode of [activeMode, activeMode === 'bash' ? 'claude' : 'bash']) {
      const list = history[mode]
      for (let i = list.length - 1; i >= 0 && matches.length < 12; i--) {
        const cmd = list[i]
        if (seen.has(cmd)) continue
        if (cmd.toLowerCase().includes(q)) {
          seen.add(cmd)
          matches.push({ cmd, mode })
        }
      }
    }
    if (!matches.length) { hideSuggestions(); return }
    selectedSuggestion = -1
    suggestionsDropdown.innerHTML = ''
    for (let i = 0; i < matches.length; i++) {
      const { cmd, mode } = matches[i]
      const item = document.createElement('div')
      item.className = 'suggestion-item'
      item.dataset.index = i
      const modeLabel = document.createElement('span')
      modeLabel.className = 'suggestion-mode'
      modeLabel.textContent = mode === 'bash' ? 'term' : 'claude'
      const textEl = document.createElement('span')
      textEl.className = 'suggestion-text'
      const matchIdx = cmd.toLowerCase().indexOf(q)
      if (matchIdx >= 0) {
        textEl.innerHTML = escapeHtml(cmd.slice(0, matchIdx))
          + '<mark>' + escapeHtml(cmd.slice(matchIdx, matchIdx + q.length)) + '</mark>'
          + escapeHtml(cmd.slice(matchIdx + q.length))
      } else {
        textEl.textContent = cmd
      }
      item.appendChild(modeLabel)
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
    hint.textContent = '\u2191\u2193 navigate \u00b7 Enter accept \u00b7 Esc dismiss'
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
    chatInput.style.height = 'auto'
    chatInput.style.height = Math.min(chatInput.scrollHeight, 120) + 'px'
    chatInput.style.overflowY = chatInput.scrollHeight > 120 ? 'auto' : 'hidden'
  }

  function positionIndicator() {
    const activeBtn = activeMode === 'bash' ? modeBashBtn : modeClaudeBtn
    const toggle = document.getElementById('mode-toggle')
    if (!toggle) return
    const toggleRect = toggle.getBoundingClientRect()
    const btnRect = activeBtn.getBoundingClientRect()
    modeIndicator.style.width = `${btnRect.width}px`
    modeIndicator.style.transform = `translateX(${btnRect.left - toggleRect.left - 2}px)`
  }

  function setMode(mode) {
    activeMode = mode
    modeBashBtn.classList.toggle('active', mode === 'bash')
    modeClaudeBtn.classList.toggle('active', mode === 'claude')
    if (panes.bash.el) panes.bash.el.classList.toggle('target-active', mode === 'bash')
    if (panes.claude.el) panes.claude.el.classList.toggle('target-active', mode === 'claude')
    chatInput.placeholder = mode === 'bash' ? 'Type a command\u2026' : 'Ask Claude\u2026'
    positionIndicator()
    resetHistoryNav()
    hideSuggestions()

    if (isMobile()) {
      if (panes.bash.el) panes.bash.el.classList.toggle('mobile-active', mode === 'bash')
      if (panes.claude.el) panes.claude.el.classList.toggle('mobile-active', mode === 'claude')
      const dots = document.querySelectorAll('.pane-dot')
      dots.forEach(dot => dot.classList.toggle('active', dot.dataset.pane === mode))
      const target = panes[mode].pane()
      if (target) requestAnimationFrame(() => target.fitAddon.fit())
    }

    if (!isMobile()) chatInput.focus()
  }

  function sendInput() {
    const text = chatInput.value
    if (!text) return
    const target = panes[activeMode].pane()
    if (target) target.sendInputWithEcho(text)
    pushHistory(text)
    resetHistoryNav()
    hideSuggestions()
    chatInput.value = ''
    autoResize()
    chatInput.focus()
  }

  // Event listeners
  modeBashBtn.addEventListener('click', () => setMode('bash'))
  modeClaudeBtn.addEventListener('click', () => setMode('claude'))
  sendBtn.addEventListener('click', sendInput)

  chatInput.addEventListener('input', () => {
    autoResize()
    resetHistoryNav()
    showSuggestions(chatInput.value)
  })

  chatInput.addEventListener('keydown', (e) => {
    const suggestionsOpen = suggestionsDropdown && !suggestionsDropdown.hidden

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      if (suggestionsOpen && selectedSuggestion >= 0) {
        const text = getSelectedSuggestionText()
        if (text) { chatInput.value = text; autoResize() }
        hideSuggestions()
        return
      }
      sendInput()
      return
    }

    if (e.key === 'Tab') {
      e.preventDefault()
      hideSuggestions()
      setMode(activeMode === 'bash' ? 'claude' : 'bash')
      return
    }

    if (e.key === 'Escape') {
      if (suggestionsOpen) { hideSuggestions() } else { chatInput.value = ''; autoResize() }
      e.preventDefault()
      return
    }

    if (e.key === 'ArrowUp') {
      e.preventDefault()
      if (suggestionsOpen) { selectSuggestion(-1); return }
      const list = history[activeMode]
      if (!list.length) return
      if (historyIdx === -1) {
        historyDraft = chatInput.value
        historyIdx = list.length - 1
      } else if (historyIdx > 0) {
        historyIdx--
      }
      chatInput.value = list[historyIdx]
      autoResize()
      hideSuggestions()
      return
    }

    if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (suggestionsOpen) { selectSuggestion(1); return }
      if (historyIdx === -1) return
      const list = history[activeMode]
      if (historyIdx < list.length - 1) {
        historyIdx++
        chatInput.value = list[historyIdx]
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
      const target = panes[activeMode].pane()
      if (target) target.sendRaw('\x03')
      return
    }

    if (e.ctrlKey && e.key === 'l') {
      e.preventDefault()
      const target = panes[activeMode].pane()
      if (target) target.sendRaw('\x0c')
      return
    }
  })

  chatInput.addEventListener('blur', () => {
    setTimeout(hideSuggestions, 150)
  })

  // Global keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.key === '`') {
      e.preventDefault()
      setMode(activeMode === 'bash' ? 'claude' : 'bash')
    }
  })

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Tab' && document.activeElement !== chatInput
        && document.activeElement?.tagName !== 'INPUT'
        && document.activeElement?.tagName !== 'TEXTAREA') {
      e.preventDefault()
      setMode(activeMode === 'bash' ? 'claude' : 'bash')
      chatInput.focus()
    }
  })

  requestAnimationFrame(() => setMode('bash'))

  // Touch toolbar
  const touchToolbar = document.getElementById('touch-toolbar')
  if (touchToolbar) {
    touchToolbar.addEventListener('click', (e) => {
      const btn = e.target.closest('.touch-btn')
      if (!btn) return
      const action = btn.dataset.action
      const target = panes[activeMode].pane()
      if (!target) return
      switch (action) {
        case 'ctrl-c': target.sendRaw('\x03'); break
        case 'ctrl-l': target.sendRaw('\x0c'); break
        case 'arrow-up': {
          const list = history[activeMode]
          if (!list.length) break
          if (historyIdx === -1) { historyDraft = chatInput.value; historyIdx = list.length - 1 }
          else if (historyIdx > 0) historyIdx--
          chatInput.value = list[historyIdx]; autoResize(); hideSuggestions()
          break
        }
        case 'arrow-down': {
          if (historyIdx === -1) break
          const list = history[activeMode]
          if (historyIdx < list.length - 1) { historyIdx++; chatInput.value = list[historyIdx] }
          else { historyIdx = -1; chatInput.value = historyDraft }
          autoResize(); hideSuggestions()
          break
        }
        case 'tab': target.sendRaw('\t'); break
        case 'escape':
          if (suggestionsDropdown && !suggestionsDropdown.hidden) hideSuggestions()
          else { chatInput.value = ''; autoResize() }
          break
      }
      if (document.activeElement === chatInput) chatInput.focus()
    })
  }

  // Orientation change handler
  mobileQuery.addEventListener('change', () => {
    if (isMobile()) {
      if (panes.bash.el) panes.bash.el.classList.toggle('mobile-active', activeMode === 'bash')
      if (panes.claude.el) panes.claude.el.classList.toggle('mobile-active', activeMode === 'claude')
    } else {
      if (panes.bash.el) panes.bash.el.classList.remove('mobile-active')
      if (panes.claude.el) panes.claude.el.classList.remove('mobile-active')
    }
    fitTerminals()
  })
}

function setupMobile() {
  if (!isMobile()) return

  // Swipe navigation
  const container = document.getElementById('split-container')
  if (container) {
    let startX = 0
    let startY = 0
    container.addEventListener('touchstart', (e) => {
      startX = e.touches[0].clientX
      startY = e.touches[0].clientY
    }, { passive: true })
    container.addEventListener('touchend', (e) => {
      const dx = e.changedTouches[0].clientX - startX
      const dy = e.changedTouches[0].clientY - startY
      if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 2) {
        const modeBash = document.getElementById('mode-bash')
        if (dx < 0) modeBash?.nextElementSibling?.click()
        else modeBash?.click()
      }
    }, { passive: true })
  }

  // iOS keyboard scroll fix
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
      document.documentElement.style.setProperty('--vvh', `${window.visualViewport.height}px`)
      killScroll()
    })
    window.visualViewport.addEventListener('scroll', killScroll)
  }
}

// --- Session drawer (mobile) ---

function openSessionDrawer() {
  renderMobileSessionDrawer()
  const drawer = document.getElementById('session-drawer')
  const backdrop = document.getElementById('session-drawer-backdrop')
  if (drawer) drawer.classList.add('open')
  if (backdrop) backdrop.classList.add('open')
}

function closeSessionDrawer() {
  const drawer = document.getElementById('session-drawer')
  const backdrop = document.getElementById('session-drawer-backdrop')
  if (drawer) drawer.classList.remove('open')
  if (backdrop) backdrop.classList.remove('open')
}

function renderMobileSessionDrawer() {
  const drawer = document.getElementById('session-drawer')
  if (!drawer) return
  drawer.innerHTML = ''

  const allSessions = []
  const diskIds = new Set(diskSessions.map(s => s.sessionId))
  for (const s of diskSessions) {
    allSessions.push({
      id: s.sessionId,
      label: s.slug || truncate(s.preview) || s.sessionId.slice(0, 8),
      isRunning: runningSessions.includes(s.sessionId),
    })
  }
  for (const id of runningSessions) {
    if (!diskIds.has(id) && id.startsWith('new-')) {
      allSessions.push({ id, label: 'New session', isRunning: true })
    }
  }

  for (const session of allSessions) {
    const item = document.createElement('div')
    item.className = 'session-drawer-item' + (session.id === activeSessionId ? ' active' : '')
    if (session.isRunning) {
      const dot = document.createElement('span')
      dot.className = 'session-tab-dot'
      item.appendChild(dot)
    }
    const label = document.createElement('span')
    label.className = 'session-drawer-item-label'
    label.textContent = session.label
    item.appendChild(label)
    item.addEventListener('click', () => {
      switchClaudeSession(session.id)
      closeSessionDrawer()
    })
    drawer.appendChild(item)
  }

  const newBtn = document.createElement('div')
  newBtn.className = 'session-drawer-new'
  newBtn.textContent = '+ New session'
  newBtn.addEventListener('click', () => {
    createClaudeSession()
    closeSessionDrawer()
  })
  drawer.appendChild(newBtn)

  // Archived section
  if (currentProjectId) {
    fetchArchivedSessions(currentProjectId).then(archived => {
      if (!archived.length) return
      const title = document.createElement('div')
      title.className = 'session-drawer-section-title'
      title.textContent = 'Archived'
      drawer.appendChild(title)

      for (const s of archived) {
        const item = document.createElement('div')
        item.className = 'session-drawer-item archived'

        const label = document.createElement('span')
        label.className = 'session-drawer-item-label'
        label.textContent = s.slug || truncate(s.preview) || s.sessionId.slice(0, 8)
        item.appendChild(label)

        const restoreBtn = document.createElement('span')
        restoreBtn.className = 'session-drawer-item-restore'
        restoreBtn.textContent = 'Unarchive'
        restoreBtn.addEventListener('click', (e) => {
          e.stopPropagation()
          doUnarchiveSession(s.sessionId)
          closeSessionDrawer()
        })
        item.appendChild(restoreBtn)

        drawer.appendChild(item)
      }
    })
  }
}
