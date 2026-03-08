/**
 * Terminal app entry — project selector, Bash + Claude panes, optional unified input bar.
 */

import { TerminalPane } from './terminal-pane.js'
import { initSplitPane } from './split-pane.js'

const STORAGE_KEY = 'lastProjectId'

const statusBash = document.getElementById('status-bash')
const statusClaude = document.getElementById('status-claude')
const projectSelect = document.getElementById('project-select')
const projectAddBtn = document.getElementById('project-add')
const projectDelBtn = document.getElementById('project-del')
const addDialog = document.getElementById('add-project-dialog')
const addForm = document.getElementById('add-project-form')
const projNameInput = document.getElementById('proj-name')
const projCwdInput = document.getElementById('proj-cwd')
const projCancelBtn = document.getElementById('proj-cancel')
const folderBreadcrumb = document.getElementById('folder-breadcrumb')
const folderList = document.getElementById('folder-list')
const folderCurrent = document.getElementById('folder-current')
const folderSelectBtn = document.getElementById('folder-select-btn')

function setStatus(el, label, connected) {
  el.textContent = `${label}: ${connected ? 'connected' : 'disconnected'}`
  el.classList.toggle('connected', connected)
}

const sessionTabsEl = document.getElementById('session-tabs')
const sessionAddBtn = document.getElementById('session-add-btn')

let projectsList = []
let bashPane = null
let claudePane = null
let diskSessions = [] // { sessionId, slug, preview, lastActivity } from disk
let runningSessions = [] // string session IDs with active PTYs
let activeSessionId = null // current claude session ID (string)
let newSessionCounter = 0 // counter for new- prefixed sessions

function getSelectedProjectId() {
  const id = projectSelect?.value
  if (id && projectsList.some((p) => p.id === id)) return id
  return projectsList[0]?.id ?? null
}

function renderProjectSelect(selectedId) {
  if (!projectSelect) return
  projectSelect.textContent = ''
  for (const p of projectsList) {
    const opt = document.createElement('option')
    opt.value = p.id
    opt.textContent = p.name
    if (p.id === selectedId) opt.selected = true
    projectSelect.appendChild(opt)
  }
}

function switchToProject(projectId) {
  if (!projectId || !bashPane || !claudePane) return
  bashPane.switchProject(projectId)
  activeSessionId = null
  claudePane.switchProject(projectId)
  fetchAndRenderSessions(projectId)
  try {
    localStorage.setItem(STORAGE_KEY, projectId)
  } catch (_) {}
}

/** Fetch disk sessions (all resumable sessions from ~/.claude/projects/) */
async function fetchDiskSessions(projectId) {
  try {
    const res = await fetch(`/api/projects/${projectId}/claude-sessions`)
    if (!res.ok) return []
    return res.json()
  } catch {
    return []
  }
}

/** Fetch running PTY session IDs */
async function fetchRunningSessions(projectId) {
  try {
    const res = await fetch(`/api/projects/${projectId}/sessions`)
    if (!res.ok) return []
    return res.json()
  } catch {
    return []
  }
}

async function fetchAndRenderSessions(projectId) {
  const [disk, running] = await Promise.all([
    fetchDiskSessions(projectId),
    fetchRunningSessions(projectId),
  ])
  diskSessions = disk
  runningSessions = running

  // If no active session, pick the most recent disk session
  if (!activeSessionId && diskSessions.length) {
    activeSessionId = diskSessions[0].sessionId
    if (claudePane) claudePane.switchSession(activeSessionId)
  }

  renderSessionTabs()
}

/** Truncate text for tab label */
function truncate(text, maxLen = 24) {
  if (!text) return ''
  return text.length > maxLen ? text.slice(0, maxLen) + '...' : text
}

function renderSessionTabs() {
  if (!sessionTabsEl) return
  sessionTabsEl.textContent = ''

  // Build combined list: disk sessions + any running new- sessions not on disk
  const allSessions = []
  const diskIds = new Set(diskSessions.map((s) => s.sessionId))

  for (const s of diskSessions) {
    allSessions.push({
      id: s.sessionId,
      label: s.slug || truncate(s.preview) || s.sessionId.slice(0, 8),
      isRunning: runningSessions.includes(s.sessionId),
    })
  }

  // Add running new- sessions that aren't on disk
  for (const id of runningSessions) {
    if (!diskIds.has(id) && id.startsWith('new-')) {
      allSessions.push({
        id,
        label: 'New session',
        isRunning: true,
      })
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

    // Close button kills PTY only (if running)
    if (session.isRunning) {
      const closeBtn = document.createElement('span')
      closeBtn.className = 'session-tab-close'
      closeBtn.textContent = '\u00d7'
      closeBtn.addEventListener('click', (e) => {
        e.stopPropagation()
        deleteClaudeSession(session.id)
      })
      tab.appendChild(closeBtn)
    }

    sessionTabsEl.appendChild(tab)
  }
}

function switchClaudeSession(sessionId) {
  if (sessionId === activeSessionId) return
  activeSessionId = sessionId
  if (claudePane) claudePane.switchSession(sessionId)
  renderSessionTabs()
}

async function createClaudeSession() {
  const newId = 'new-' + newSessionCounter++
  activeSessionId = newId
  if (claudePane) claudePane.switchSession(newId)
  const projectId = getSelectedProjectId()
  if (projectId) {
    // Re-fetch to include the new running session
    runningSessions = await fetchRunningSessions(projectId)
    renderSessionTabs()
  }
}

async function deleteClaudeSession(sessionId) {
  const projectId = getSelectedProjectId()
  if (!projectId) return

  await fetch(`/api/projects/${projectId}/sessions/${sessionId}`, { method: 'DELETE' })

  // If deleting active session, switch to another
  if (sessionId === activeSessionId) {
    // Pick next available session (prefer disk sessions)
    const next =
      diskSessions.find((s) => s.sessionId !== sessionId) ||
      runningSessions.find((id) => id !== sessionId)
    activeSessionId = next?.sessionId || next || null
    if (claudePane && activeSessionId) claudePane.switchSession(activeSessionId)
  }

  await fetchAndRenderSessions(projectId)
}

async function fetchProjects() {
  const res = await fetch('/api/projects')
  if (!res.ok) throw new Error('Failed to load projects')
  return res.json()
}

function basename(path) {
  const segments = path.replace(/\/$/, '').split('/').filter(Boolean)
  return segments.length ? segments[segments.length - 1] : ''
}

async function fetchDir(path) {
  const url = path ? `/api/fs?path=${encodeURIComponent(path)}` : '/api/fs'
  const res = await fetch(url)
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err.error || 'Failed to list folder')
  }
  return res.json()
}

let browsePath = ''

function renderBreadcrumb(path, homeLabel = 'Home') {
  if (!folderBreadcrumb) return
  folderBreadcrumb.textContent = ''
  const homeLink = document.createElement('a')
  homeLink.href = '#'
  homeLink.textContent = homeLabel
  homeLink.dataset.path = ''
  homeLink.addEventListener('click', (e) => {
    e.preventDefault()
    loadFolder('')
  })
  folderBreadcrumb.appendChild(homeLink)
  if (!path) return
  const parts = path.replace(/\/$/, '').split('/').filter(Boolean)
  for (let i = 0; i < parts.length; i++) {
    const segPath = '/' + parts.slice(0, i + 1).join('/')
    folderBreadcrumb.appendChild(document.createTextNode(' / '))
    const a = document.createElement('a')
    a.href = '#'
    a.textContent = parts[i]
    a.dataset.path = segPath
    a.addEventListener('click', (e) => {
      e.preventDefault()
      loadFolder(segPath)
    })
    folderBreadcrumb.appendChild(a)
  }
}

function renderFolderList(entries, currentPath) {
  if (!folderList) return
  folderList.textContent = ''
  for (const entry of entries) {
    if (!entry.isDir) continue
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.textContent = entry.name
    btn.dataset.name = entry.name
    const nextPath = currentPath ? `${currentPath}/${entry.name}` : entry.name
    btn.addEventListener('click', () => loadFolder(nextPath))
    folderList.appendChild(btn)
  }
}

async function loadFolder(path) {
  browsePath = path
  try {
    const data = await fetchDir(path || undefined)
    const currentPath = data.path
    browsePath = currentPath
    renderBreadcrumb(currentPath)
    renderFolderList(data.entries || [], currentPath)
    if (folderCurrent) folderCurrent.textContent = currentPath || '(home)'
  } catch (e) {
    console.error(e)
    if (folderCurrent) folderCurrent.textContent = 'Error: ' + e.message
    if (folderList) folderList.textContent = ''
  }
}

function openAddProjectDialog() {
  projNameInput.value = ''
  projCwdInput.value = ''
  browsePath = ''
  loadFolder('')
  addDialog.showModal()
}

function selectCurrentFolder() {
  const path = browsePath
  if (!path) return
  projCwdInput.value = path
  const name = basename(path)
  if (name && !projNameInput.value.trim()) projNameInput.value = name
}

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
    onStatusChange: (c) => setStatus(statusClaude, 'Claude', c),
  })
}

async function init() {
  try {
    projectsList = await fetchProjects()
  } catch (e) {
    console.error(e)
    projectsList = []
  }

  const lastId =
    typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null
  const projectId =
    lastId && projectsList.some((p) => p.id === lastId)
      ? lastId
      : (projectsList[0]?.id ?? null)

  renderProjectSelect(projectId)
  if (projectId) {
    // Fetch disk sessions first so we know which session to connect to
    const disk = await fetchDiskSessions(projectId)
    diskSessions = disk
    if (disk.length) {
      activeSessionId = disk[0].sessionId
    }
    createPanes(projectId)
    fetchAndRenderSessions(projectId)
  } else {
    renderSessionTabs()
  }

  if (sessionAddBtn) {
    sessionAddBtn.addEventListener('click', createClaudeSession)
  }

  if (projectSelect) {
    projectSelect.addEventListener('change', () => {
      const id = getSelectedProjectId()
      if (id) switchToProject(id)
    })
  }

  if (projectAddBtn && addDialog && addForm && projNameInput && projCwdInput) {
    projectAddBtn.addEventListener('click', openAddProjectDialog)
    projCancelBtn?.addEventListener('click', () => addDialog.close())
    if (folderSelectBtn) folderSelectBtn.addEventListener('click', selectCurrentFolder)
    addForm.addEventListener('submit', async (e) => {
      e.preventDefault()
      const name = projNameInput.value.trim()
      const cwd = projCwdInput.value.trim()
      if (!name || !cwd) {
        alert('Enter a project name and select a folder.')
        return
      }
      try {
        const res = await fetch('/api/projects', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, cwd }),
        })
        if (!res.ok) throw new Error('Failed to add project')
        const project = await res.json()
        projectsList = await fetchProjects()
        renderProjectSelect(project.id)
        if (!bashPane || !claudePane) {
          createPanes(project.id)
        } else {
          switchToProject(project.id)
        }
        addDialog.close()
      } catch (err) {
        console.error(err)
        alert(err.message || 'Failed to add project')
      }
    })
  }

  if (projectDelBtn && projectSelect) {
    projectDelBtn.addEventListener('click', async () => {
      const id = getSelectedProjectId()
      if (!id) return
      if (projectsList.length <= 1) {
        alert('Cannot delete the only project.')
        return
      }
      if (!confirm('Delete this project? Terminal sessions for this project will end.'))
        return
      try {
        const res = await fetch(`/api/projects/${id}`, { method: 'DELETE' })
        if (!res.ok) throw new Error('Failed to delete project')
        projectsList = await fetchProjects()
        const nextId = projectsList[0]?.id ?? null
        renderProjectSelect(nextId)
        switchToProject(nextId)
        if (nextId) {
          // Panes already exist; switchProject reconnects them
        } else {
          if (bashPane) bashPane.dispose()
          if (claudePane) claudePane.dispose()
          bashPane = null
          claudePane = null
        }
      } catch (err) {
        console.error(err)
        alert(err.message || 'Failed to delete project')
      }
    })
  }

  initSplitPane(
    document.getElementById('split-container'),
    document.getElementById('split-divider')
  )

  // --- Mode toggle + unified input (if present) ---
  const panes = {
    bash: { pane: () => bashPane, el: document.querySelector('.pane-left') },
    claude: { pane: () => claudePane, el: document.querySelector('.pane-right') },
  }
  let activeMode = 'bash'
  const modeBashBtn = document.getElementById('mode-bash')
  const modeClaudeBtn = document.getElementById('mode-claude')
  const modeIndicator = document.getElementById('mode-indicator')
  const chatInput = document.getElementById('chat-input')
  const sendBtn = document.getElementById('send-btn')
  const suggestionsDropdown = document.getElementById('suggestions-dropdown')

  if (modeBashBtn && modeClaudeBtn && modeIndicator && chatInput && sendBtn) {
    // ---- Command history (per mode, persisted to localStorage) ----
    const HISTORY_KEY = 'cmdHistory'
    const MAX_HISTORY = 200

    /** @returns {{ bash: string[], claude: string[] }} */
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
      } catch {
        /* ignore */
      }
      return { bash: [], claude: [] }
    }

    function saveHistory() {
      try {
        localStorage.setItem(HISTORY_KEY, JSON.stringify(history))
      } catch {
        /* ignore */
      }
    }

    const history = loadHistory()

    /** Add a command to the active mode's history. */
    function pushHistory(text) {
      const list = history[activeMode]
      // Deduplicate consecutive repeats
      if (list.length && list[list.length - 1] === text) return
      list.push(text)
      if (list.length > MAX_HISTORY) list.splice(0, list.length - MAX_HISTORY)
      saveHistory()
    }

    // History navigation cursor: -1 = not browsing, 0..N = index from end
    let historyIdx = -1
    let historyDraft = '' // saves what was typed before browsing

    function resetHistoryNav() {
      historyIdx = -1
      historyDraft = ''
    }

    // ---- Suggestions dropdown ----
    let selectedSuggestion = -1

    function showSuggestions(query) {
      if (!suggestionsDropdown || !query.trim()) {
        hideSuggestions()
        return
      }

      const q = query.toLowerCase()
      // Search across both modes' histories, deduplicate, prefer recent
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

      if (!matches.length) {
        hideSuggestions()
        return
      }

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
        // Highlight the matching portion
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

        item.appendChild(modeLabel)
        item.appendChild(textEl)

        item.addEventListener('mousedown', (e) => {
          e.preventDefault() // don't blur textarea
          chatInput.value = cmd
          autoResize()
          hideSuggestions()
          chatInput.focus()
        })

        suggestionsDropdown.appendChild(item)
      }

      // Hint footer
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
      // Remove current selection
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

    // ---- Auto-resize textarea ----

    function autoResize() {
      chatInput.style.height = 'auto'
      chatInput.style.height = Math.min(chatInput.scrollHeight, 120) + 'px'
      chatInput.style.overflowY = chatInput.scrollHeight > 120 ? 'auto' : 'hidden'
    }

    // ---- Mode toggle ----

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
      if (panes.claude.el)
        panes.claude.el.classList.toggle('target-active', mode === 'claude')
      chatInput.placeholder = mode === 'bash' ? 'Type a command…' : 'Ask Claude…'
      positionIndicator()
      resetHistoryNav()
      hideSuggestions()
      chatInput.focus()
    }

    // ---- Send input with local echo (fixes high-ping lag) ----

    function sendInput() {
      const text = chatInput.value
      if (!text) return

      const target = panes[activeMode].pane()
      if (target) {
        // sendInputWithEcho local-echoes the text for instant visual feedback
        // on high-latency connections, then sends text + \r to the PTY.
        target.sendInputWithEcho(text)
      }

      pushHistory(text)
      resetHistoryNav()
      hideSuggestions()
      chatInput.value = ''
      autoResize()
      chatInput.focus()
    }

    // ---- Event listeners ----

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

      // --- Enter: send ---
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        // If a suggestion is selected, accept it first
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

      // --- Tab: switch between Terminal / Claude mode ---
      if (e.key === 'Tab') {
        e.preventDefault()
        hideSuggestions()
        setMode(activeMode === 'bash' ? 'claude' : 'bash')
        return
      }

      // --- Escape: close suggestions or clear input ---
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

      // --- Up/Down: suggestions navigation or history ---
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        if (suggestionsOpen) {
          selectSuggestion(-1)
          return
        }
        // History navigation
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
        if (suggestionsOpen) {
          selectSuggestion(1)
          return
        }
        // History navigation
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

      // --- Ctrl+C: send interrupt to active PTY ---
      if (e.ctrlKey && e.key === 'c' && !chatInput.value) {
        e.preventDefault()
        const target = panes[activeMode].pane()
        if (target) target.sendRaw('\x03')
        return
      }

      // --- Ctrl+L: send clear to active PTY ---
      if (e.ctrlKey && e.key === 'l') {
        e.preventDefault()
        const target = panes[activeMode].pane()
        if (target) target.sendRaw('\x0c')
        return
      }
    })

    // Close suggestions when focus leaves
    chatInput.addEventListener('blur', () => {
      // Small delay so mousedown on suggestion fires first
      setTimeout(hideSuggestions, 150)
    })

    // --- Ctrl+` to toggle mode (global, works even when chat not focused) ---
    document.addEventListener('keydown', (e) => {
      if (e.ctrlKey && e.key === '`') {
        e.preventDefault()
        setMode(activeMode === 'bash' ? 'claude' : 'bash')
      }
    })

    // --- Tab to toggle mode (global, when chat not focused) ---
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Tab' && document.activeElement !== chatInput) {
        e.preventDefault()
        setMode(activeMode === 'bash' ? 'claude' : 'bash')
        chatInput.focus()
      }
    })

    requestAnimationFrame(() => setMode('bash'))
  }
}

init()
