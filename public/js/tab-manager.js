/**
 * Multi-tab bash terminal manager.
 *
 * Tabs are server-side metadata (persisted in data/nanocode.json). Every
 * connected client subscribes to /ws/tabs and reflects the canonical list.
 * Opening the workspace on a second device shows the same tabs and
 * re-attaches to the same in-memory PTYs (via /ws/terminal + tabId).
 *
 * activeId is local-per-device (each browser remembers its own focused tab).
 */

import { TerminalPane } from './terminal-pane.js'
import { fetchTabs, createTab, deleteTab, patchTab } from './api.js'

const ACTIVE_KEY_PREFIX = 'activeTab:'

function loadActiveId(projectId) {
  try { return localStorage.getItem(ACTIVE_KEY_PREFIX + projectId) || null } catch { return null }
}
function saveActiveId(projectId, id) {
  try {
    if (id) localStorage.setItem(ACTIVE_KEY_PREFIX + projectId, id)
    else localStorage.removeItem(ACTIVE_KEY_PREFIX + projectId)
  } catch {}
}

export class TabManager {
  /**
   * @param {{
   *   stripEl: HTMLElement,
   *   stackEl: HTMLElement,
   *   projectId: string,
   *   onActiveChange?: (pane: TerminalPane | null) => void,
   *   onStatusChange?: (connected: boolean) => void,
   * }} opts
   */
  constructor(opts) {
    this.stripEl = opts.stripEl
    this.stackEl = opts.stackEl
    this.projectId = opts.projectId
    this.onActiveChange = opts.onActiveChange || (() => {})
    this.onStatusChange = opts.onStatusChange || (() => {})

    /** @type {{ id: string, label: string, pane: TerminalPane, paneEl: HTMLElement }[]} */
    this.tabs = []
    this.activeId = null
    this._pendingActiveId = null  // set after POST so we focus the new tab when it arrives via broadcast
    this._creatingEmpty = false   // guard against duplicate auto-creates when list is empty

    // WS subscription
    this._ws = null
    this._wsBackoff = 500
    this._wsReconnectTimer = null
    this._disposed = false

    // Delegated double-click → rename
    this.stripEl.addEventListener('dblclick', (e) => {
      const chip = e.target.closest('.tab-chip')
      if (!chip) return
      e.preventDefault()
      e.stopPropagation()
      const id = chip.dataset.tabId
      const tab = this.tabs.find((t) => t.id === id)
      if (!tab) return
      const label = chip.querySelector('.tab-chip-label')
      if (!label) return
      this._beginRename(tab, label, chip)
    })

    this._renderStrip()
  }

  /**
   * Initialize: subscribe to /ws/tabs. The first broadcast is a snapshot;
   * subsequent broadcasts arrive on every mutation.
   */
  restore() {
    this._connectWs()
  }

  /** Deprecated alias retained for callers. */
  ensureFirstTab() { this.restore() }

  // --- Public mutations ---

  async newTab(type = 'bash') {
    try {
      const tab = await createTab(this.projectId, { type })
      this._pendingActiveId = tab.id
      // The WS broadcast that follows will add the tab + setActive.
      return tab.id
    } catch (err) {
      console.error('newTab failed', err)
    }
  }

  async closeTab(id) {
    try { await deleteTab(this.projectId, id) }
    catch (err) { console.error('closeTab failed', err) }
  }

  async renameTab(id, label) {
    try { await patchTab(this.projectId, id, label) }
    catch (err) { console.error('rename failed', err) }
  }

  // --- Public local helpers ---

  setActive(id) {
    if (this.activeId === id) return
    if (!this.tabs.some((t) => t.id === id)) return
    // Compute direction so the composer chip animates left (forward) /
    // right (back) appropriately. 'jump' for non-adjacent moves.
    const n = this.tabs.length
    const oldIdx = this.tabs.findIndex((t) => t.id === this.activeId)
    const newIdx = this.tabs.findIndex((t) => t.id === id)
    let direction = 'jump'
    if (oldIdx >= 0 && newIdx >= 0 && n > 1) {
      if ((oldIdx + 1) % n === newIdx) direction = 'forward'
      else if ((newIdx + 1) % n === oldIdx) direction = 'back'
    }
    this.activeId = id
    saveActiveId(this.projectId, id)
    for (const tab of this.tabs) {
      tab.paneEl.classList.toggle('active', tab.id === id)
    }
    this._renderStrip()
    const active = this._getActive()
    this.onActiveChange(active?.pane || null, active ? { id: active.id, label: active.label, type: active.type } : null, direction)
    if (active) {
      this.onStatusChange(!!active.pane._ws && active.pane._ws.readyState === WebSocket.OPEN)
      requestAnimationFrame(() => { try { active.pane.fitAddon.fit() } catch {} })
    }
  }

  cycle(dir = 1) {
    if (this.tabs.length < 2) return
    const idx = this.tabs.findIndex((t) => t.id === this.activeId)
    const next = (idx + dir + this.tabs.length) % this.tabs.length
    this.setActive(this.tabs[next].id)
  }

  jumpTo(n) {
    const tab = this.tabs[n - 1]
    if (tab) this.setActive(tab.id)
  }

  getActivePane() {
    return this._getActive()?.pane || null
  }

  /** Return shallow copies of the prev / current / next tabs for the
   *  composer's 3-segment chip. With 1 tab, prev and next are null;
   *  with 2 tabs, prev and next both point at the same other tab. */
  getNeighbors() {
    const n = this.tabs.length
    if (n === 0 || !this.activeId) return { prev: null, current: null, next: null }
    const idx = this.tabs.findIndex((t) => t.id === this.activeId)
    if (idx < 0) return { prev: null, current: null, next: null }
    const pick = (t) => t ? { id: t.id, label: t.label, type: t.type } : null
    return {
      prev: n > 1 ? pick(this.tabs[(idx - 1 + n) % n]) : null,
      current: pick(this.tabs[idx]),
      next: n > 1 ? pick(this.tabs[(idx + 1) % n]) : null,
    }
  }

  count() {
    return this.tabs.length
  }

  /** Project switch: tear down local panes + WS, re-subscribe to new project. */
  switchProject(projectId) {
    if (projectId === this.projectId) return
    for (const tab of this.tabs) {
      try { tab.pane.dispose() } catch {}
      tab.paneEl.remove()
    }
    this.tabs = []
    this.activeId = null
    this._pendingActiveId = null
    this._creatingEmpty = false
    this.projectId = projectId
    this._teardownWs()
    this._renderStrip()
    this._connectWs()
  }

  fit() {
    const active = this._getActive()
    if (active) requestAnimationFrame(() => { try { active.pane.fitAddon.fit() } catch {} })
  }

  destroy() {
    this._disposed = true
    this._teardownWs()
    for (const tab of this.tabs) {
      try { tab.pane.dispose() } catch {}
      tab.paneEl.remove()
    }
    this.tabs = []
    this.activeId = null
  }

  // --- WS subscription ---

  _connectWs() {
    if (this._disposed) return
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const ws = new WebSocket(`${proto}//${location.host}/ws/tabs`)
    this._ws = ws
    ws.addEventListener('open', () => {
      this._wsBackoff = 500
      ws.send(JSON.stringify({ type: 'subscribe', projectId: this.projectId }))
    })
    ws.addEventListener('message', (e) => {
      let msg
      try { msg = JSON.parse(e.data) } catch { return }
      if (msg.type === 'tabs:update' && msg.projectId === this.projectId) {
        this._applyServerTabs(msg.tabs || [])
      }
    })
    ws.addEventListener('close', () => {
      if (this._disposed) return
      // Reconnect with capped exponential backoff
      const delay = Math.min(this._wsBackoff, 10_000)
      this._wsBackoff = Math.min(this._wsBackoff * 2, 10_000)
      clearTimeout(this._wsReconnectTimer)
      this._wsReconnectTimer = setTimeout(() => this._connectWs(), delay)
    })
    ws.addEventListener('error', () => {/* close fires next */})
  }

  _teardownWs() {
    clearTimeout(this._wsReconnectTimer)
    this._wsReconnectTimer = null
    if (this._ws) {
      try { this._ws.close() } catch {}
      this._ws = null
    }
  }

  _applyServerTabs(serverTabs) {
    const serverById = new Map(serverTabs.map((t) => [t.id, t]))

    // Add tabs that are new on the server
    for (const t of serverTabs) {
      const local = this.tabs.find((x) => x.id === t.id)
      if (!local) {
        this._addTab(t.id, t.label, t.type || 'bash')
      } else {
        if (local.label !== t.label) local.label = t.label
        if (t.type && local.type !== t.type) local.type = t.type
      }
    }

    // Remove tabs gone from the server
    for (let i = this.tabs.length - 1; i >= 0; i--) {
      const t = this.tabs[i]
      if (!serverById.has(t.id)) {
        try { t.pane.dispose() } catch {}
        t.paneEl.remove()
        this.tabs.splice(i, 1)
      }
    }

    // Reorder to match server order
    this.tabs.sort(
      (a, b) =>
        serverTabs.findIndex((t) => t.id === a.id) -
        serverTabs.findIndex((t) => t.id === b.id)
    )

    // Empty-list auto-create — guard against multiple devices racing.
    if (this.tabs.length === 0 && !this._creatingEmpty) {
      this._creatingEmpty = true
      this.newTab().finally(() => { this._creatingEmpty = false })
      this._renderStrip()
      return
    }

    // Active-tab logic
    if (this._pendingActiveId && serverById.has(this._pendingActiveId)) {
      const id = this._pendingActiveId
      this._pendingActiveId = null
      this.setActive(id)
    } else if (this.activeId && !serverById.has(this.activeId)) {
      // The previously-active tab was removed (possibly by another device).
      this.activeId = null
      if (this.tabs.length) this.setActive(this.tabs[0].id)
      else this._renderStrip()
    } else if (!this.activeId && this.tabs.length) {
      // First-time activation: prefer the last-active for this device.
      const remembered = loadActiveId(this.projectId)
      const target = (remembered && serverById.has(remembered)) ? remembered : this.tabs[0].id
      this.setActive(target)
    } else {
      this._renderStrip()
    }
  }

  // --- Internals ---

  _addTab(id, label, type = 'bash') {
    const paneEl = document.createElement('div')
    paneEl.className = 'pane-terminal'
    paneEl.dataset.tabId = id
    this.stackEl.appendChild(paneEl)

    const pane = new TerminalPane(paneEl, {
      projectId: this.projectId,
      tabId: id,
      onStatusChange: (connected) => {
        if (this.activeId === id) this.onStatusChange(connected)
      },
    })

    this.tabs.push({ id, label, type, pane, paneEl })
  }

  _getActive() {
    return this.tabs.find((t) => t.id === this.activeId) || null
  }

  _beginRename(tab, labelEl, btnEl) {
    if (!labelEl.parentNode) return

    const input = document.createElement('input')
    input.type = 'text'
    input.className = 'tab-chip-input'
    input.value = tab.label
    input.maxLength = 40
    input.spellcheck = false

    let done = false
    const commit = (save) => {
      if (done) return
      done = true
      if (save) {
        const v = input.value.trim()
        if (v && v !== tab.label) {
          // Server will broadcast back; local label updates then.
          this.renameTab(tab.id, v)
        }
      }
      this._renderStrip()
    }

    input.addEventListener('keydown', (e) => {
      e.stopPropagation()
      if (e.key === 'Enter') { e.preventDefault(); commit(true) }
      else if (e.key === 'Escape') { e.preventDefault(); commit(false) }
      else if (e.key === 'Tab') { e.preventDefault(); commit(true) }
    })
    input.addEventListener('blur', () => commit(true))
    input.addEventListener('click', (e) => e.stopPropagation())
    input.addEventListener('dblclick', (e) => e.stopPropagation())

    labelEl.replaceWith(input)
    input.focus()
    input.select()
  }

  _renderStrip() {
    this.stripEl.innerHTML = ''
    for (const tab of this.tabs) {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'tab-chip tab-chip-' + (tab.type || 'bash') +
        (tab.id === this.activeId ? ' active' : '')
      btn.dataset.tabId = tab.id
      btn.title = 'Double-click to rename'

      const icon = document.createElement('span')
      icon.className = 'tab-chip-icon'
      icon.innerHTML = TYPE_ICON_SVG[tab.type || 'bash'] || TYPE_ICON_SVG.bash
      btn.appendChild(icon)

      const label = document.createElement('span')
      label.className = 'tab-chip-label'
      label.textContent = tab.label
      btn.appendChild(label)

      const close = document.createElement('span')
      close.className = 'tab-chip-close'
      close.textContent = '×'
      close.title = 'Close tab'
      close.addEventListener('click', (e) => {
        e.stopPropagation()
        this.closeTab(tab.id)
      })
      btn.appendChild(close)

      btn.addEventListener('click', () => this.setActive(tab.id))
      this.stripEl.appendChild(btn)
    }

    const addBtn = document.createElement('button')
    addBtn.type = 'button'
    addBtn.className = 'tab-chip-add'
    addBtn.textContent = '+'
    addBtn.title = 'New tab — click for menu, Ctrl+T for bash'
    addBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      this._showNewTabMenu(addBtn)
    })
    this.stripEl.appendChild(addBtn)
  }

  _showNewTabMenu(anchor) {
    // Dismiss any open menu
    this._closeNewTabMenu()
    const menu = document.createElement('div')
    menu.className = 'tab-new-menu'
    for (const opt of NEW_TAB_OPTIONS) {
      const item = document.createElement('button')
      item.type = 'button'
      item.className = 'tab-new-menu-item'
      item.innerHTML =
        `<span class="tab-new-menu-icon">${TYPE_ICON_SVG[opt.type] || ''}</span>` +
        `<span class="tab-new-menu-label">${opt.label}</span>` +
        (opt.hint ? `<span class="tab-new-menu-hint">${opt.hint}</span>` : '')
      item.addEventListener('click', () => {
        this._closeNewTabMenu()
        this.newTab(opt.type)
      })
      menu.appendChild(item)
    }
    document.body.appendChild(menu)
    const rect = anchor.getBoundingClientRect()
    menu.style.position = 'fixed'
    menu.style.top = (rect.bottom + 6) + 'px'
    menu.style.left = rect.left + 'px'
    this._menuEl = menu
    // Click-outside closes
    setTimeout(() => {
      const close = (e) => {
        if (!menu.contains(e.target)) {
          this._closeNewTabMenu()
          document.removeEventListener('click', close, true)
        }
      }
      document.addEventListener('click', close, true)
    }, 0)
  }

  _closeNewTabMenu() {
    if (this._menuEl) {
      this._menuEl.remove()
      this._menuEl = null
    }
  }
}

const NEW_TAB_OPTIONS = [
  { type: 'bash', label: 'Terminal', hint: 'bash' },
  { type: 'claude', label: 'Claude Code', hint: 'claude' },
  { type: 'codex', label: 'Codex', hint: 'codex' },
  { type: 'agent', label: 'Cursor Agent', hint: 'agent' },
  { type: 'opencode', label: 'OpenCode', hint: 'opencode' },
]

const TYPE_ICON_SVG = {
  bash: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>`,
  claude: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M9 9.5a3 3 0 1 1 0 5"/><path d="M15 9.5a3 3 0 1 0 0 5"/></svg>`,
  codex: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>`,
  agent: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="3 11 22 2 13 21 11 13 3 11"/></svg>`,
  opencode: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M8 9l-3 3 3 3M16 9l3 3-3 3"/></svg>`,
}

export { TYPE_ICON_SVG }
