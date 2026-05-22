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

function setStatus(connected) {
  if (!statusBash) return
  statusBash.textContent = `Bash: ${connected ? 'connected' : 'disconnected'}`
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
}

function setupTabs(projectId) {
  const stripEl = document.getElementById('terminal-tab-strip')
  const stackEl = document.getElementById('terminal-stack')
  if (!stripEl || !stackEl) return

  tabManager = new TabManager({
    stripEl,
    stackEl,
    projectId,
    onActiveChange: (pane) => {
      activePane = pane
      updateActiveTabChip()
    },
    onStatusChange: setStatus,
  })
  tabManager.restore()
  // Re-render carousel when window resizes (recompute translateX so
  // the active slot stays centered).
  window.addEventListener('resize', () => updateActiveTabChip({ noAnim: true }))
}

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

function setupChatInput() {
  const chatInput = document.getElementById('chat-input')
  const sendBtn = document.getElementById('send-btn')
  const suggestionsDropdown = document.getElementById('suggestions-dropdown')

  if (!chatInput || !sendBtn) return

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

  function sendInput() {
    const text = chatInput.value
    if (!text) return
    if (activePane) activePane.sendInputWithEcho(text)
    pushHistory(text)
    resetHistoryNav()
    hideSuggestions()
    chatInput.value = ''
    autoResize()
    chatInput.focus()
  }

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
      if (suggestionsOpen) {
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
    setTimeout(hideSuggestions, 150)
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
}
