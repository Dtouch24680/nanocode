/**
 * Agent health frontend.
 * Subscribes to /ws/notify (type=agent_health) + seeds from GET /api/agents/health.
 * Maintains per-session_key health state; renders panel banner + tab chip dots.
 *
 * Dismiss semantics:
 *   Clicking "→ View/Review" navigates to the tab AND dismisses that row.
 *   Clicking "×" or right-swiping dismisses without navigating.
 *   A dismissed row is suppressed as long as its state doesn't change.
 *   If the backend emits a new state for the same session_key, suppression clears.
 */

const CLEAR_STATES = new Set(['active', 'completed', 'stopped'])

const STATE_META = {
  active:          { label: 'active',         urgent: false, color: 'ok'   },
  idle:            { label: 'idle',            urgent: false, color: 'warn' },
  stuck:           { label: 'stuck',           urgent: true,  color: 'err'  },
  approval_needed: { label: 'needs approval',  urgent: true,  color: 'err'  },
  rate_limited:    { label: 'rate limited',    urgent: false, color: 'warn' },
  crashed:         { label: 'crashed',         urgent: true,  color: 'err'  },
  completed:       { label: 'completed',       urgent: false, color: 'ok'   },
  stopped:         { label: 'stopped',         urgent: false, color: 'ok'   },
}

/** @type {Map<string, object>} session_key → health row */
const _healthMap = new Map()

/** @type {Map<string, string>} session_key → dismissed state (suppression) */
const _dismissedMap = new Map()

/** Registered by app.js after terminal-view is ready */
let _navigateFn = null

// ── Public API ────────────────────────────────────────────────────────────────

export function setNavigateHandler(fn) {
  _navigateFn = fn
}

export function updateAgentHealth(row) {
  if (!row || !row.session_key) return

  // If state changed vs dismissed state → clear suppression so row can show again
  if (_dismissedMap.has(row.session_key) && _dismissedMap.get(row.session_key) !== row.state) {
    _dismissedMap.delete(row.session_key)
  }

  if (CLEAR_STATES.has(row.state)) {
    _healthMap.delete(row.session_key)
    _dismissedMap.delete(row.session_key)
  } else {
    _healthMap.set(row.session_key, row)
  }
  _render()
}

export function getHealthForTab(tabId) {
  for (const row of _healthMap.values()) {
    if (row.tab_id === tabId) return row
  }
  return null
}

/** Re-apply dots to all currently-rendered tab slots. */
export function refreshChipDots() {
  for (const chip of document.querySelectorAll('.tab-slot[data-tab-id]')) {
    _applyChipDot(chip, getHealthForTab(chip.dataset.tabId))
  }
}

export async function seedFromServer() {
  try {
    const data = await fetch('/api/agents/health').then(r => r.json())
    for (const row of (data.agents || [])) {
      if (!row.session_key) continue
      if (CLEAR_STATES.has(row.state)) {
        _healthMap.delete(row.session_key)
        _dismissedMap.delete(row.session_key)
      } else {
        // Don't reset dismissal on seed — only state-change should reset it
        _healthMap.set(row.session_key, row)
      }
    }
    _render()
  } catch (e) {
    console.warn('[agent-health] seed failed', e)
  }
}

// ── Navigate ──────────────────────────────────────────────────────────────────

function _navigateToTab(tabId) {
  if (!tabId) return
  // Prefer the registered handler (terminal-view's tabManager.setActive)
  if (_navigateFn) {
    _navigateFn(tabId)
    return
  }
  // Fallback: click the slot in the tab strip
  const chip = document.querySelector(`.tab-slot[data-tab-id="${CSS.escape(tabId)}"]`)
  if (chip) chip.click()
}

// ── Dismiss ───────────────────────────────────────────────────────────────────

function _dismissRow(sessionKey, currentState, tabId, navigate) {
  _dismissedMap.set(sessionKey, currentState)
  if (navigate && tabId) _navigateToTab(tabId)
  _render()
}

// ── Chip dot ──────────────────────────────────────────────────────────────────

function _applyChipDot(chip, row) {
  chip.querySelector('.tab-health-dot')?.remove()
  if (!row || CLEAR_STATES.has(row.state) || row.state === 'active') return

  const dot = document.createElement('span')
  dot.className = `tab-health-dot ah-${STATE_META[row.state]?.color || 'warn'}`
  dot.title = STATE_META[row.state]?.label || row.state
  const label = chip.querySelector('.tab-slot-label')
  if (label) chip.insertBefore(dot, label)
  else chip.appendChild(dot)
}

// ── Panel banner ──────────────────────────────────────────────────────────────

function _getOrCreatePanel() {
  let panel = document.getElementById('agent-health-panel')
  if (!panel) {
    panel = document.createElement('div')
    panel.id = 'agent-health-panel'
    panel.className = 'agent-health-panel'
    const stack = document.getElementById('terminal-stack')
    if (stack?.parentNode) stack.parentNode.insertBefore(panel, stack)
    else document.body.appendChild(panel)
  }
  return panel
}

function _fmtDuration(sec) {
  if (!sec || sec < 1) return ''
  if (sec < 60) return `${Math.round(sec)}s`
  const m = Math.floor(sec / 60), s = Math.round(sec % 60)
  return s > 0 ? `${m}m ${s}s` : `${m}m`
}

// ── Swipe-to-dismiss gesture ──────────────────────────────────────────────────

const SWIPE_THRESHOLD_X = 60  // px horizontal to trigger dismiss
const SWIPE_MAX_Y = 40        // px max vertical drift

function _attachSwipeDismiss(rowEl, sessionKey, currentState) {
  let startX = 0, startY = 0, tracking = false, capturing = false

  rowEl.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return  // left button only for mouse
    startX = e.clientX
    startY = e.clientY
    tracking = true
    capturing = false
  }, { passive: true })

  rowEl.addEventListener('pointermove', (e) => {
    if (!tracking) return
    const dx = e.clientX - startX
    const dy = Math.abs(e.clientY - startY)
    // Only start capturing when clearly swiping right (not a click / vertical scroll)
    if (!capturing && dx > 8 && dx > dy) {
      capturing = true
      try { rowEl.setPointerCapture(e.pointerId) } catch {}
    }
    if (capturing && dx > 0 && dy < SWIPE_MAX_Y) {
      rowEl.style.transform = `translateX(${dx}px)`
      rowEl.style.opacity = String(Math.max(0, 1 - dx / 200))
    }
  }, { passive: true })

  const _finish = (e) => {
    if (!tracking) return
    tracking = false
    const dx = e.clientX - startX
    const dy = Math.abs(e.clientY - startY)
    if (capturing && dx > SWIPE_THRESHOLD_X && dy < SWIPE_MAX_Y) {
      rowEl.style.transition = 'transform 0.18s ease, opacity 0.18s ease'
      rowEl.style.transform = `translateX(200%)`
      rowEl.style.opacity = '0'
      setTimeout(() => _dismissRow(sessionKey, currentState, null, false), 180)
    } else if (capturing) {
      rowEl.style.transition = 'transform 0.18s ease, opacity 0.18s ease'
      rowEl.style.transform = ''
      rowEl.style.opacity = ''
      setTimeout(() => { rowEl.style.transition = '' }, 200)
    }
    capturing = false
  }

  rowEl.addEventListener('pointerup', _finish, { passive: true })
  rowEl.addEventListener('pointercancel', () => {
    tracking = false
    capturing = false
    rowEl.style.transform = ''
    rowEl.style.opacity = ''
    rowEl.style.transition = ''
  }, { passive: true })
}

// ── Main render ───────────────────────────────────────────────────────────────

function _render() {
  const panel = _getOrCreatePanel()

  // Build visible list: alerted + not currently suppressed
  const visible = [..._healthMap.values()].filter(row =>
    _dismissedMap.get(row.session_key) !== row.state
  )

  if (visible.length === 0) {
    panel.hidden = true
    panel.innerHTML = ''
    refreshChipDots()
    return
  }

  // Urgent rows first
  visible.sort((a, b) => {
    const ua = STATE_META[a.state]?.urgent ? 0 : 1
    const ub = STATE_META[b.state]?.urgent ? 0 : 1
    return ua - ub
  })

  panel.hidden = false
  panel.innerHTML = ''

  for (const row of visible) {
    const meta = STATE_META[row.state] || { label: row.state, urgent: false, color: 'warn' }
    const dur = _fmtDuration(row.wait_seconds || row.idle_seconds)
    const isApproval = row.state === 'approval_needed'

    const rowEl = document.createElement('div')
    rowEl.className = `agent-health-row ah-${meta.color}`
    rowEl.dataset.sessionKey = row.session_key

    // ── Left: dot + name + badge + duration ──────────────────────────────────
    const left = document.createElement('div')
    left.className = 'agent-health-left'

    const dot = document.createElement('span')
    dot.className = `agent-health-dot ah-${meta.color}`
    left.appendChild(dot)

    const nameEl = document.createElement('span')
    nameEl.className = 'agent-health-name'
    nameEl.textContent = `[${row.provider || row.tab_type || 'agent'}]`
    left.appendChild(nameEl)

    const badge = document.createElement('span')
    badge.className = `agent-health-badge ah-${meta.color}`
    badge.textContent = meta.label
    left.appendChild(badge)

    if (dur) {
      const durEl = document.createElement('span')
      durEl.className = 'agent-health-dur'
      durEl.textContent = dur
      left.appendChild(durEl)
    }

    rowEl.appendChild(left)

    // ── Right: last_line + CTA + dismiss ─────────────────────────────────────
    const right = document.createElement('div')
    right.className = 'agent-health-right'

    if (row.last_line) {
      const ll = document.createElement('span')
      ll.className = 'agent-health-lastline'
      ll.title = row.last_line
      ll.textContent = row.last_line.length > 80 ? row.last_line.slice(0, 79) + '…' : row.last_line
      right.appendChild(ll)
    }

    if (row.tab_id) {
      const cta = document.createElement('button')
      cta.type = 'button'
      cta.className = `agent-health-cta ah-${meta.color}`
      cta.textContent = isApproval ? '→ Review' : '→ View'
      // Navigate to tab AND dismiss
      cta.addEventListener('click', (e) => {
        e.stopPropagation()
        _dismissRow(row.session_key, row.state, row.tab_id, true)
      })
      right.appendChild(cta)
    }

    // Dismiss (×) button — dismiss without navigating
    const closeBtn = document.createElement('button')
    closeBtn.type = 'button'
    closeBtn.className = 'agent-health-close'
    closeBtn.textContent = '×'
    closeBtn.title = 'Dismiss'
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      _dismissRow(row.session_key, row.state, null, false)
    })
    right.appendChild(closeBtn)

    rowEl.appendChild(right)
    panel.appendChild(rowEl)

    // Attach swipe-to-dismiss (captures session_key + state at render time)
    _attachSwipeDismiss(rowEl, row.session_key, row.state)
  }

  refreshChipDots()
}
