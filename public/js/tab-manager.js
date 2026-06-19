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
import { ClaudeBlockRenderer } from './claude-block-renderer.js'
import { CodexBlockRenderer } from './codex-block-renderer.js'
import { OpenCodeBlockRenderer } from './opencode-block-renderer.js'
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

    // Carousel track — all pane DOM lives here side-by-side. The
    // track's translateX selects which pane is visible, and the CSS
    // transition is the slide animation. Created once per TabManager;
    // re-used across switchProject() calls.
    this.trackEl = document.createElement('div')
    this.trackEl.className = 'terminal-track no-anim'
    this.stackEl.appendChild(this.trackEl)

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
    // Adjacent moves get the slide animation; everything else (jumps,
    // first activation, wrap-around at the ends of the strip) snaps so
    // the track doesn't visibly whizz past every intermediate pane.
    const adjacent = Math.abs(newIdx - oldIdx) === 1 && oldIdx >= 0
    this.activeId = id
    saveActiveId(this.projectId, id)
    for (const tab of this.tabs) {
      tab.paneEl.classList.toggle('active', tab.id === id)
    }
    this._syncTrackPosition({ noAnim: !adjacent })
    this._renderStrip()
    this._scrollActiveIntoView()
    const active = this._getActive()
    this.onActiveChange(active?.pane || null, active ? { id: active.id, label: active.label, type: active.type } : null, direction)
    if (active) {
      this.onStatusChange(!!active.pane._ws && active.pane._ws.readyState === WebSocket.OPEN)
      requestAnimationFrame(() => {
        try { active.pane.fitAddon.fit() } catch {}
        // A pane may have rendered/replayed its history while hidden (scrollHeight
        // was 0), so re-pin it to the bottom now that it's visible.
        try { active.pane.onActivated?.() } catch {}
      })
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
    // Mirror that order into the carousel track so the translateX math
    // stays in sync with the array. appendChild on an existing child is
    // a move, so iterating in tab-order pushes each pane to its new
    // position without disturbing the others.
    for (const tab of this.tabs) {
      this.trackEl.appendChild(tab.paneEl)
    }
    this._syncTrackPosition({ noAnim: true })

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
      // First-time activation: prefer the last-active for this device, or the
      // most-recently-active claude tab (by jsonl mtime) for cross-port resume.
      const remembered = loadActiveId(this.projectId)
      if (remembered && serverById.has(remembered)) {
        this.setActive(remembered)
      } else {
        // No remembered tab for this device: auto-select the most recently active
        // claude tab by querying the server (jsonl mtime). Falls back to tabs[0].
        this._autoSelectMostRecentClaudeTab(serverById)
      }
    } else {
      this._renderStrip()
    }
  }

  /**
   * Query /api/projects/:id/most-recent-claude-tab and activate that tab.
   * Falls back to tabs[0] if the API fails or returns null.
   * Only called on first-time activation (no remembered tab for this device).
   */
  async _autoSelectMostRecentClaudeTab(serverById) {
    let tabId = null
    try {
      const resp = await fetch(`/api/projects/${this.projectId}/most-recent-claude-tab`)
      if (resp.ok) {
        const data = await resp.json()
        tabId = data?.tabId || null
      }
    } catch {}

    // Pick the API result if it's valid, else fall back to first tab
    const target = (tabId && serverById.has(tabId)) ? tabId : this.tabs[0]?.id
    if (target) this.setActive(target)
    else this._renderStrip()
  }

  // --- Internals ---

  _addTab(id, label, type = 'bash') {
    const paneEl = document.createElement('div')
    paneEl.className = 'pane-terminal'
    paneEl.dataset.tabId = id
    this.trackEl.appendChild(paneEl)

    const paneOpts = {
      projectId: this.projectId,
      tabId: id,
      onStatusChange: (connected) => {
        if (this.activeId === id) this.onStatusChange(connected)
      },
    }

    // Claude tabs use a DOM block renderer by default (rich text, mobile-friendly).
    // If the global renderMode setting is 'terminal', use raw PTY instead.
    // Codex tabs: separate codexRenderMode setting, defaults to 'block' (CodexBlockRenderer
    // over the structured SDK JSON path). Set codexRenderMode to 'terminal' in Settings to
    // fall back to the legacy raw-PTY xterm view.
    const renderMode = (() => { try { return window.__nanocodeState?.renderMode || 'block' } catch { return 'block' } })()
    const codexRenderMode = (() => { try { return window.__nanocodeState?.codexRenderMode || 'block' } catch { return 'block' } })()
    const opencodeRenderMode = (() => { try { return window.__nanocodeState?.opencodeRenderMode || 'block' } catch { return 'block' } })()
    const useClaudeRenderer = type === 'claude' && renderMode !== 'terminal'
    const useCodexRenderer = type === 'codex' && codexRenderMode !== 'terminal'
    const useOpenCodeRenderer = type === 'opencode' && opencodeRenderMode !== 'terminal'
    let pane
    if (useClaudeRenderer) {
      pane = new ClaudeBlockRenderer(paneEl, paneOpts)
    } else if (useCodexRenderer) {
      pane = new CodexBlockRenderer(paneEl, paneOpts)
    } else if (useOpenCodeRenderer) {
      pane = new OpenCodeBlockRenderer(paneEl, paneOpts)
    } else {
      pane = new TerminalPane(paneEl, paneOpts)
    }

    this.tabs.push({ id, label, type, pane, paneEl })
    // Track grew; keep the visible position pinned to the active tab.
    this._syncTrackPosition({ noAnim: true })
  }

  /** Move the carousel track so the active tab is in view. */
  _syncTrackPosition({ noAnim = false } = {}) {
    if (!this.trackEl) return
    const idx = this.tabs.findIndex((t) => t.id === this.activeId)
    if (idx < 0) {
      // No active tab — keep the current transform; the next setActive
      // will re-align.
      return
    }
    if (noAnim) {
      this.trackEl.classList.add('no-anim')
      this.trackEl.style.transform = `translateX(-${idx * 100}%)`
      // Force a layout flush so the transform paints before we lift the
      // no-anim guard, otherwise the next setActive would animate from
      // the OLD position.
      void this.trackEl.offsetWidth
      requestAnimationFrame(() => this.trackEl.classList.remove('no-anim'))
    } else {
      this.trackEl.classList.remove('no-anim')
      this.trackEl.style.transform = `translateX(-${idx * 100}%)`
    }
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

  /**
   * Scroll the active tab chip into view, centered within the strip's
   * visible viewport. Stops centering once either edge of the scroll
   * content is reached (so the first/last tabs rest at the strip edge
   * instead of leaving empty space). Mirrors the composer chip's
   * centering logic but for the top horizontal strip.
   */
  _scrollActiveIntoView() {
    if (!this.stripEl) return
    const active = this.stripEl.querySelector('.tab-chip.active')
    if (!active) return
    const strip = this.stripEl
    const chipLeft = active.offsetLeft
    const chipWidth = active.offsetWidth
    const chipCenter = chipLeft + chipWidth / 2
    const viewport = strip.clientWidth
    let target = chipCenter - viewport / 2
    const maxScroll = strip.scrollWidth - viewport
    target = Math.max(0, Math.min(target, Math.max(0, maxScroll)))
    strip.scrollTo({ left: target, behavior: 'smooth' })
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

    // Divider + "resume an existing conversation" entry (takeover flow).
    // Lists every claude session jsonl in this project's cwd — including ones
    // started outside nanocode (e.g. a `claude` running in a tmux window in the
    // same dir) — and resumes the picked one into the normal block UI.
    const divider = document.createElement('div')
    divider.className = 'tab-new-menu-divider'
    menu.appendChild(divider)
    const resumeItem = document.createElement('button')
    resumeItem.type = 'button'
    resumeItem.className = 'tab-new-menu-item'
    resumeItem.innerHTML =
      `<span class="tab-new-menu-icon">${RESUME_ICON_SVG}</span>` +
      `<span class="tab-new-menu-label">进入已有会话…</span>` +
      `<span class="tab-new-menu-hint">resume</span>`
    resumeItem.addEventListener('click', () => {
      this._closeNewTabMenu()
      this._showResumePicker(anchor)
    })
    menu.appendChild(resumeItem)

    this._positionMenu(menu, anchor)
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

  /**
   * Position a floating menu just below its anchor button, clamped to the
   * viewport so it never overflows the right edge (the + button sits at the
   * far right of the strip on mobile) or the bottom edge (long resume lists).
   */
  _positionMenu(menu, anchor) {
    document.body.appendChild(menu)
    const rect = anchor.getBoundingClientRect()
    const menuRect = menu.getBoundingClientRect()
    const vw = window.innerWidth
    const vh = window.innerHeight
    let left = rect.left
    let top = rect.bottom + 6
    // Clamp horizontally: keep the entire menu within the viewport, with a
    // small margin so it doesn't kiss the screen edge on phones.
    const margin = 8
    if (left + menuRect.width > vw - margin) {
      left = Math.max(margin, vw - margin - menuRect.width)
    }
    if (left < margin) left = margin
    // Clamp vertically: if it would run off the bottom, flip above the anchor.
    if (top + menuRect.height > vh - margin) {
      const above = rect.top - 6 - menuRect.height
      if (above >= margin) {
        top = above
      } else {
        // Both below and above overflow — pin to bottom edge and let it scroll.
        top = Math.max(margin, vh - margin - menuRect.height)
      }
    }
    menu.style.position = 'fixed'
    menu.style.top = top + 'px'
    menu.style.left = left + 'px'
  }

  _closeNewTabMenu() {
    if (this._menuEl) {
      this._menuEl.remove()
      this._menuEl = null
    }
  }

  /**
   * Show a picker of existing claude sessions in this project's cwd and resume
   * the chosen one. Reuses the 'nanocode:resume-session' event, which already
   * activates the owning tab (if any) or creates a new claude tab pre-loaded
   * with the sessionId — driving the standard history replay + --resume path.
   */
  async _showResumePicker(anchor) {
    this._closeNewTabMenu()
    const menu = document.createElement('div')
    menu.className = 'tab-new-menu tab-resume-menu'
    menu.innerHTML = `<div class="tab-resume-loading">载入会话…</div>`
    this._positionMenu(menu, anchor)
    this._menuEl = menu

    let sessions = []
    try {
      sessions = await fetch(`/api/projects/${this.projectId}/agent-sessions`).then(r => r.json())
    } catch {
      menu.innerHTML = `<div class="tab-resume-loading">载入失败</div>`
      this._positionMenu(menu, anchor)
      return
    }
    if (this._menuEl !== menu) return  // dismissed while loading
    menu.innerHTML = ''
    if (!Array.isArray(sessions) || !sessions.length) {
      menu.innerHTML = `<div class="tab-resume-loading">无已有会话</div>`
      this._positionMenu(menu, anchor)
      return
    }

    // Group sessions by agent type for visual grouping.
    const TYPE_LABELS = { claude: 'Claude', codex: 'Codex', opencode: 'OpenCode' }
    const grouped = {}
    for (const s of sessions) {
      const t = s.type || 'claude'
      if (!grouped[t]) grouped[t] = []
      grouped[t].push(s)
    }
    const typeOrder = ['claude', 'codex', 'opencode']
    for (const t of typeOrder) {
      const group = grouped[t]
      if (!group || !group.length) continue
      const header = document.createElement('div')
      header.className = 'tab-resume-group-header'
      header.textContent = TYPE_LABELS[t] || t
      menu.appendChild(header)
      for (const s of group) {
        const item = document.createElement('button')
        item.type = 'button'
        item.className = 'tab-new-menu-item tab-resume-item'
        const dot = s.active ? '<span class="tab-resume-dot active"></span>'
          : (s.hasTab ? '<span class="tab-resume-dot open"></span>' : '<span class="tab-resume-dot"></span>')
        const summary = (s.summary || '(无摘要)').replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]))
        item.innerHTML =
          `${dot}` +
          `<span class="tab-new-menu-label tab-resume-summary">${summary}</span>` +
          `<span class="tab-new-menu-hint">${s.hasTab ? '已开 · ' : ''}${s.relTime}</span>`
        item.title = s.sessionId
        item.addEventListener('click', () => {
          this._closeNewTabMenu()
          document.dispatchEvent(new CustomEvent('nanocode:resume-session', {
            detail: { projectId: this.projectId, sessionId: s.sessionId, type: s.type },
          }))
        })
        menu.appendChild(item)
      }
    }
    // Re-position after content loads: the menu height changes once the
    // session list renders, so vertical clamping needs to be recomputed.
    this._positionMenu(menu, anchor)
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
  // Claude: official Anthropic/Claude mark (the stylized "burst" glyph,
  // simple-icons). Fill-based so it inherits currentColor like the active
  // accents expect.
  claude: `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z"/></svg>`,
  // Codex: official OpenAI mark (the six-petal knot). Source: Wikimedia
  // Commons "OpenAI Logo". viewBox crops to the knot's bounding box.
  codex: `<svg width="14" height="14" viewBox="-6.57 -2.14 334.80 362.34" fill="currentColor"><path d="m297.06 130.97c7.26-21.79 4.76-45.66-6.85-65.48-17.46-30.4-52.56-46.04-86.84-38.68-15.25-17.18-37.16-26.95-60.13-26.81-35.04-.08-66.13 22.48-76.91 55.82-22.51 4.61-41.94 18.7-53.31 38.67-17.59 30.32-13.58 68.54 9.92 94.54-7.26 21.79-4.76 45.66 6.85 65.48 17.46 30.4 52.56 46.04 86.84 38.68 15.24 17.18 37.16 26.95 60.13 26.8 35.06.09 66.16-22.49 76.94-55.86 22.51-4.61 41.94-18.7 53.31-38.67 17.57-30.32 13.55-68.51-9.94-94.51zm-120.28 168.11c-14.03.02-27.62-4.89-38.39-13.88.49-.26 1.34-.73 1.89-1.07l63.72-36.8c3.26-1.85 5.26-5.32 5.24-9.07v-89.83l26.93 15.55c.29.14.48.42.52.74v74.39c-.04 33.08-26.83 59.9-59.91 59.97zm-128.84-55.03c-7.03-12.14-9.56-26.37-7.15-40.18.47.28 1.3.79 1.89 1.13l63.72 36.8c3.23 1.89 7.23 1.89 10.47 0l77.79-44.92v31.1c.02.32-.13.63-.38.83l-64.41 37.19c-28.69 16.52-65.33 6.7-81.92-21.95zm-16.77-139.09c7-12.16 18.05-21.46 31.21-26.29 0 .55-.03 1.52-.03 2.2v73.61c-.02 3.74 1.98 7.21 5.23 9.06l77.79 44.91-26.93 15.55c-.27.18-.61.21-.91.08l-64.42-37.22c-28.63-16.58-38.45-53.21-21.95-81.89zm221.26 51.49-77.79-44.92 26.93-15.54c.27-.18.61-.21.91-.08l64.42 37.19c28.68 16.57 38.51 53.26 21.94 81.94-7.01 12.14-18.05 21.44-31.2 26.28v-75.81c.03-3.74-1.96-7.2-5.2-9.06zm26.8-40.34c-.47-.29-1.3-.79-1.89-1.13l-63.72-36.8c-3.23-1.89-7.23-1.89-10.47 0l-77.79 44.92v-31.1c-.02-.32.13-.63.38-.83l64.41-37.16c28.69-16.55 65.37-6.7 81.91 22 6.99 12.12 9.52 26.31 7.15 40.1zm-168.51 55.43-26.94-15.55c-.29-.14-.48-.42-.52-.74v-74.39c.02-33.12 26.89-59.96 60.01-59.94 14.01 0 27.57 4.92 38.34 13.88-.49.26-1.33.73-1.89 1.07l-63.72 36.8c-3.26 1.85-5.26 5.31-5.24 9.06l-.04 89.79zm14.63-31.54 34.65-20.01 34.65 20v40.01l-34.65 20-34.65-20z"/></svg>`,
  // Cursor Agent: official Cursor logo (simple-icons).
  agent: `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M11.503.131 1.891 5.678a.84.84 0 0 0-.42.726v11.188c0 .3.162.575.42.724l9.609 5.55a1 1 0 0 0 .998 0l9.61-5.55a.84.84 0 0 0 .42-.724V6.404a.84.84 0 0 0-.42-.726L12.497.131a1.01 1.01 0 0 0-.996 0M2.657 6.338h18.55c.263 0 .43.287.297.515L12.23 22.918c-.062.107-.229.064-.229-.06V12.335a.59.59 0 0 0-.295-.51l-9.11-5.257c-.109-.063-.064-.23.061-.23"/></svg>`,
  // OpenCode: official OpenCode logo (simple-icons).
  opencode: `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M22 24H2V0h20zM17 4.8H7v14.4h10z"/></svg>`,
}

// Generic "history/clock" icon for the resume-session menu entry — not tied
// to any specific agent brand since the picker lists sessions from all agents.
const RESUME_ICON_SVG = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/></svg>`

export { TYPE_ICON_SVG }
