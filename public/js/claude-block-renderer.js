/**
 * ClaudeBlockRenderer (stream-json edition)
 *
 * Replaces the PTY/ANSI-based renderer. The server now speaks
 * `{type:'claude-event', event}` line-delimited JSON (claude CLI
 * --output-format=stream-json). No ANSI stripping, no TUI inference.
 *
 * Public API mirrors TerminalPane:
 *   new ClaudeBlockRenderer(container, { projectId, tabId, onStatusChange })
 *   .sendInputWithEcho(text)   — sends user turn + echoes prompt block
 *   .sendRaw(data)             — only Ctrl+C / Ctrl+L forwarded
 *   .fitAddon                  — stub { fit: () => {} }
 *   .dispose()
 *
 * WS protocol (to server):
 *   {type:'attach', projectId, sessionType:'bash', tabId, cols:200, rows:50}
 *   {type:'claude-input', text:'...'} — user turn
 *   {type:'ping', id}
 *
 * WS protocol (from server):
 *   {type:'claude-event', event:{type:'system'|'assistant'|'partial_message'|'result'|'rate_limit_event',...}}
 *   {type:'exit', exitCode}
 *   {type:'error', error}
 *   {type:'pong', id}
 */

// ── WS constants ──────────────────────────────────────────────────────────────
const WS_PATH = '/ws/terminal'
const BACKOFF_BASE = 500
const BACKOFF_MAX = 10_000
const PING_INTERVAL_MS = 5000

// ── Tool-block fold level ──────────────────────────────────────────────────────
// Three levels (persisted in localStorage):
//   'full'    — show tool name + full input/output content (default)
//   'header'  — show only the tool name header
//   'line'    — collapse to a single thin line (just a coloured stripe)
const TOOL_FOLD_KEY = 'cbr_tool_fold'
const TOOL_FOLD_LEVELS = ['full', 'header', 'line']

function getToolFoldLevel() {
  const v = localStorage.getItem(TOOL_FOLD_KEY)
  return TOOL_FOLD_LEVELS.includes(v) ? v : 'full'
}

// ── Subagent visibility toggles ───────────────────────────────────────────────
// Two independent booleans (persisted in localStorage):
//   cbr_subagent_prompt  — show the message/prompt sent TO a subagent (default on)
//   cbr_subagent_activity — show subagent internal activity (nested events, default off)
const SUBAGENT_PROMPT_KEY = 'cbr_subagent_prompt'
const SUBAGENT_ACTIVITY_KEY = 'cbr_subagent_activity'

function getSubagentPromptVisible() {
  const v = localStorage.getItem(SUBAGENT_PROMPT_KEY)
  return v === null ? true : v !== 'false'
}

function setSubagentPromptVisible(val) {
  localStorage.setItem(SUBAGENT_PROMPT_KEY, val ? 'true' : 'false')
  // Apply immediately to all existing subagent-prompt blocks.
  // When making a block visible, also ensure data-fold='full' so the body
  // content is shown (not folded away by the global tool-fold setting).
  document.querySelectorAll('.cbr-block-subagent-prompt').forEach((el) => {
    el.style.display = val ? '' : 'none'
    if (val) el.setAttribute('data-fold', 'full')
  })
  document.dispatchEvent(new CustomEvent('cbr:subagent-prompt-changed', { detail: { visible: val } }))
}

function getSubagentActivityVisible() {
  const v = localStorage.getItem(SUBAGENT_ACTIVITY_KEY)
  return v === null ? false : v === 'true'
}

function setSubagentActivityVisible(val) {
  localStorage.setItem(SUBAGENT_ACTIVITY_KEY, val ? 'true' : 'false')
  // Apply immediately to all existing subagent-activity blocks
  document.querySelectorAll('.cbr-block-subagent-activity').forEach((el) => {
    el.style.display = val ? '' : 'none'
  })
  document.dispatchEvent(new CustomEvent('cbr:subagent-activity-changed', { detail: { visible: val } }))
}

function setToolFoldLevel(level) {
  if (!TOOL_FOLD_LEVELS.includes(level)) return
  localStorage.setItem(TOOL_FOLD_KEY, level)
  // Apply to all currently-rendered tool blocks in the page
  document.querySelectorAll('.cbr-block-tool, .cbr-block-tool-result').forEach((el) => {
    applyToolFold(el, level)
  })
  document.dispatchEvent(new CustomEvent('cbr:tool-fold-changed', { detail: { level } }))
}

function applyToolFold(el, level) {
  el.setAttribute('data-fold', level || getToolFoldLevel())
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function renderMarkdown(text) {
  if (!text) return ''
  try {
    if (window.marked && window.DOMPurify) {
      return window.DOMPurify.sanitize(window.marked.parse(text))
    }
  } catch {}
  // Minimal fallback
  const lines = text.split('\n')
  let out = ''
  for (const line of lines) {
    const safe = line
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.+?)\*/g, '<em>$1</em>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
    if (/^#{1,6}\s/.test(line)) {
      const level = line.match(/^(#+)/)[1].length
      out += `<h${level} class="cbr-h">${safe.replace(/^#+\s*/, '')}</h${level}>`
    } else if (line.trim() === '') {
      out += '<br>'
    } else {
      out += `<p>${safe}</p>`
    }
  }
  return out
}

function renderCode(code, lang) {
  let inner = ''
  try {
    if (window.hljs && lang) {
      inner = window.hljs.highlight(code, { language: lang, ignoreIllegals: true }).value
    } else if (window.hljs) {
      inner = window.hljs.highlightAuto(code).value
    }
  } catch {}
  if (!inner) inner = escHtml(code)
  const langLabel = lang ? `<span class="cbr-code-lang">${escHtml(lang)}</span>` : ''
  return (
    `<div class="cbr-code-wrap">` +
    `<div class="cbr-code-header">${langLabel}<button class="cbr-copy-btn" aria-label="Copy code">Copy</button></div>` +
    `<pre class="cbr-pre"><code class="cbr-code">${inner}</code></pre>` +
    `</div>`
  )
}

function attachCopyHandlers(el) {
  el.querySelectorAll('.cbr-copy-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation()
      const pre = btn.closest('.cbr-code-wrap')?.querySelector('pre')
      const text = pre ? pre.textContent : el.textContent
      navigator.clipboard.writeText(text).then(() => {
        const orig = btn.textContent
        btn.textContent = 'Copied!'
        setTimeout(() => { btn.textContent = orig }, 1500)
      }).catch(() => {})
    })
  })
}

// ── Main class ────────────────────────────────────────────────────────────────

export class ClaudeBlockRenderer {
  constructor(container, opts = {}) {
    this.container = container
    this.projectId = opts.projectId
    this.tabId = opts.tabId
    this.onStatusChange = opts.onStatusChange || (() => {})

    this.fitAddon = { fit: () => {} }

    container.classList.add('cbr-container')
    this._scroll = document.createElement('div')
    this._scroll.className = 'cbr-scroll'
    container.appendChild(this._scroll)

    // ── Scroll-to-bottom button ────────────────────────────────────────────────
    // Floats over the scroll area; appears when the user is not at the bottom.
    this._scrollBtn = document.createElement('button')
    this._scrollBtn.className = 'cbr-scroll-to-bottom'
    this._scrollBtn.setAttribute('aria-label', 'Scroll to bottom')
    this._scrollBtn.title = 'Scroll to bottom'
    this._scrollBtn.innerHTML =
      `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">` +
      `<polyline points="6 9 12 15 18 9"/></svg>`
    this._scrollBtn.addEventListener('click', () => {
      this._scroll.scrollTo({ top: this._scroll.scrollHeight, behavior: 'smooth' })
    })
    container.appendChild(this._scrollBtn)

    // Show/hide the button based on scroll position (debounced via rAF)
    let _scrollRafPending = false
    this._scroll.addEventListener('scroll', () => {
      if (_scrollRafPending) return
      _scrollRafPending = true
      requestAnimationFrame(() => {
        _scrollRafPending = false
        this._updateScrollBtn()
      })
    }, { passive: true })

    this._ws = null
    this._exited = false
    this._reconnectAttempts = 0
    this._reconnectTimer = null
    this._pingInterval = null

    // Track the in-progress assistant message block (partial_message updates)
    this._liveAssistantBlock = null
    this._liveAssistantId = null  // message id if available

    // Track the in-progress subagent streaming activity block (separate from main live block)
    this._liveSubagentBlock = null

    // UUID dedup set for subagent history-replay events (avoid double-render on reconnect)
    this._seenSubagentUuids = new Set()

    // UUID dedup set for jsonl history replay — prevents double-render when:
    //   1. jsonl replay runs on first connect, AND
    //   2. in-memory cs.history also replays the same events (same-session reconnect)
    // Every event rendered via _fetchAndReplayHistory has its uuid stored here.
    // _handleEvent checks this set before processing any incoming server event.
    this._replayedUuids = new Set()

    // Thinking state: true when claude is processing a turn
    this._thinking = false

    this._connect()
  }

  _updateScrollBtn() {
    const s = this._scroll
    // Consider "at bottom" if within 60px of the bottom (handles rounding/sub-px)
    const atBottom = s.scrollHeight - s.scrollTop - s.clientHeight < 60
    this._scrollBtn.classList.toggle('cbr-scroll-btn-visible', !atBottom)
  }

  // ── Thinking state (for external UI) ────────────────────────────────────────

  isThinking() {
    return this._thinking
  }

  _setThinking(val) {
    if (this._thinking === val) return
    this._thinking = val
    // Broadcast to terminal-view.js so input bar can react
    document.dispatchEvent(new CustomEvent('nanocode:claude-thinking', {
      detail: { tabId: this.tabId, thinking: val },
    }))
  }

  // ── Public API ───────────────────────────────────────────────────────────────

  sendInputWithEcho(text) {
    // Generate a nonce so the server echoes back a 'user' event with this same
    // nonce. When our WS receives that broadcast we can recognise it as our own
    // locally-echoed turn and skip rendering it again (dedup). On reconnect the
    // 'user' event is replayed from server history without the nonce matching any
    // pending-set entry, so it *will* be rendered — fixing the reconnect bug.
    const nonce = (Math.random() * 0xFFFFFFFF | 0).toString(36) + Date.now().toString(36)
    if (!this._pendingNonces) this._pendingNonces = new Set()
    this._pendingNonces.add(nonce)
    this._appendUserBlock(text)
    this._send({ type: 'claude-input', text, _nonce: nonce })
    // Clear any live assistant block so next response starts fresh
    this._liveAssistantBlock = null
    this._liveAssistantId = null
    // Enter thinking state
    this._setThinking(true)
  }

  sendRaw(data) {
    // Only forward Ctrl+C (interrupt) and Ctrl+L (clear screen stub).
    // Claude stream-json has no concept of raw keystrokes; Ctrl+C can
    // signal the user wants to interrupt — we restart the session.
    if (data === '\x03') {
      this._addSystemBlock('[Ctrl+C — to restart session, type /restart]')
    }
    // Ctrl+L: visually clear the scroll area
    if (data === '\x0c') {
      this._scroll.innerHTML = ''
    }
  }

  dispose() {
    clearTimeout(this._reconnectTimer)
    this._stopPing()
    if (this._ws) {
      this._ws.onclose = null
      this._ws.close()
      this._ws = null
    }
  }

  // ── jsonl history replay ─────────────────────────────────────────────────────

  /**
   * Fetch the persisted claude session history from the server and replay it
   * into the renderer. Called once on first WS open (not reconnects — those
   * replay from in-memory cs.history via the WS broadcast).
   *
   * De-dup strategy: every replayed event's uuid is stored in _replayedUuids.
   * When the WS subsequently replays cs.history (which may overlap for the same
   * session), _handleEvent skips events whose uuid was already rendered here.
   * For cross-port / new-process scenarios cs.history is empty, so no overlap.
   */
  async _fetchAndReplayHistory() {
    const url = `/api/projects/${this.projectId}/tabs/${this.tabId}/history`
    let data
    try {
      const resp = await fetch(url)
      if (!resp.ok) return  // 404 for non-claude tab or missing project — silent
      data = await resp.json()
    } catch {
      return  // network error — degrade gracefully
    }

    const events = data?.events
    if (!Array.isArray(events) || events.length === 0) return

    // Show a subtle separator so the user knows this is restored history
    this._addSystemBlock(`[Restored ${events.length} event(s) from session history]`)

    for (const event of events) {
      // Track uuid for dedup against later WS replay (must happen BEFORE render
      // so that the WS replay path sees it; pass opts.fromReplay=true so the
      // _handleEvent dedup guard doesn't block the initial render itself).
      if (event.uuid) this._replayedUuids.add(event.uuid)
      this._handleEvent(event, { fromReplay: true })
    }
  }

  // ── WS connection ────────────────────────────────────────────────────────────

  _connect() {
    this._exited = false
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    this._ws = new WebSocket(`${proto}//${location.host}${WS_PATH}`)

    this._ws.onopen = () => {
      const isReconnect = this._reconnectAttempts > 0
      this._reconnectAttempts = 0
      this.onStatusChange(true)

      // On reconnect the server will replay the full cs.history. Clear the
      // render area so history is displayed exactly once (not old render +
      // replayed render = double). Also reset all live-block pointers so
      // partial_message / assistant events start fresh.
      if (isReconnect) {
        this._scroll.innerHTML = ''
        this._liveAssistantBlock = null
        this._liveAssistantId = null
        this._liveSubagentBlock = null
        this._seenSubagentUuids = new Set()
        this._pendingNonces = new Set()
        this._thinking = false
        this._addSystemBlock('[Reconnected. Restoring session history…]')
      } else {
        // First connection: fetch and replay persisted jsonl history from disk.
        // This gives cross-port and cross-server-restart continuity — the user
        // sees past turns even when the in-memory cs.history is empty (new process).
        this._fetchAndReplayHistory()
      }

      this._send({
        type: 'attach',
        projectId: this.projectId,
        sessionType: 'bash',
        tabId: this.tabId,
        cols: 200,
        rows: 50,
      })
      this._startPing()
    }

    this._ws.onmessage = (e) => {
      let msg
      try { msg = JSON.parse(e.data) } catch { return }

      if (msg.type === 'claude-event') {
        this._handleEvent(msg.event)
      } else if (msg.type === 'pong') {
        // ignore
      } else if (msg.type === 'exit') {
        this._exited = true
        this._addSystemBlock(`[Session ended (exit ${msg.exitCode ?? '?'}). Send a message to start a new session.]`)
      } else if (msg.type === 'error') {
        this._addSystemBlock('[Error: ' + (msg.error || 'unknown') + ']')
      }
    }

    this._ws.onclose = () => {
      this._stopPing()
      this.onStatusChange(false)
      if (!this._exited) {
        const delay = Math.min(BACKOFF_BASE * 2 ** this._reconnectAttempts, BACKOFF_MAX)
        this._reconnectAttempts++
        this._addSystemBlock(`[Connection lost. Reconnecting in ${(delay / 1000).toFixed(1)}s…]`)
        clearTimeout(this._reconnectTimer)
        this._reconnectTimer = setTimeout(() => this._connect(), delay)
      }
    }

    this._ws.onerror = () => {}
  }

  _send(msg) {
    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
      this._ws.send(JSON.stringify(msg))
    }
  }

  _startPing() {
    this._stopPing()
    this._pingInterval = setInterval(() => {
      this._send({ type: 'ping', id: Date.now() })
    }, PING_INTERVAL_MS)
  }

  _stopPing() {
    if (this._pingInterval) {
      clearInterval(this._pingInterval)
      this._pingInterval = null
    }
  }

  // ── Event dispatch ────────────────────────────────────────────────────────────

  _handleEvent(event, opts = {}) {
    if (!event || !event.type) return

    // Dedup: if this event was already rendered via _fetchAndReplayHistory (jsonl replay),
    // skip it to avoid double-rendering when cs.history replays the same events.
    // We check uuid on user/assistant events; other types (system, result, etc.) have no uuid.
    // opts.fromReplay=true means the call IS the initial jsonl replay → skip the dedup check.
    if (!opts.fromReplay && event.uuid && this._replayedUuids && this._replayedUuids.has(event.uuid)) {
      // The event was already rendered from jsonl; skip the WS replay duplicate.
      // Do NOT delete from _replayedUuids — a second reconnect must still dedup.
      return
    }

    switch (event.type) {
      case 'system':
        this._handleSystem(event)
        break
      case 'assistant':
        this._handleAssistant(event)
        break
      case 'partial_message':
        this._handlePartialMessage(event)
        break
      case 'result':
        this._handleResult(event)
        break
      case 'rate_limit_event':
        this._handleRateLimit(event)
        break
      // 'user' events come from two sources:
      //   1. Real-time broadcast: the server echoes back our own turn right after
      //      we sent it. We can skip rendering because _appendUserBlock() already
      //      showed it (dedup via nonce).
      //   2. History replay on reconnect: the server stored the event in cs.history
      //      and replays it when we reconnect. In this case no matching nonce is
      //      pending, so we *must* render it so the user can see their past turns.
      case 'user':
        this._handleUserEvent(event)
        break
      default:
        // Unknown event: ignore silently
        break
    }

    // Dispatch for TTS and other listeners
    document.dispatchEvent(new CustomEvent('nanocode:terminal-output', {
      detail: JSON.stringify(event),
    }))
  }

  _handleUserEvent(event) {
    // Dedup: if we sent this turn ourselves, a nonce will be in _pendingNonces.
    // Consume and skip so we don't double-render the locally echoed block.
    const nonce = event._nonce
    if (nonce && this._pendingNonces && this._pendingNonces.has(nonce)) {
      this._pendingNonces.delete(nonce)
      return
    }

    let content = event.message?.content
    // Normalize: jsonl user messages may have content as a plain string (the user's text).
    // Wrap it in the array form the renderer expects so all code paths work uniformly.
    if (typeof content === 'string') {
      content = [{ type: 'text', text: content }]
    }
    if (!Array.isArray(content)) return

    // Subagent activity: events with parent_tool_use_id are messages TO a subagent
    // or results FROM a subagent. Visibility controlled by the subagent-activity toggle.
    // Root F fix: NEVER return early — always build DOM, set display:none if toggle off.
    // This makes the toggle reversible for events that already streamed through.
    const parentToolUseId = event.parent_tool_use_id
    if (parentToolUseId) {
      // UUID dedup: on history replay the same subagent events come again; skip if seen
      const uuid = event.uuid
      if (uuid) {
        if (this._seenSubagentUuids.has(uuid)) return
        this._seenSubagentUuids.add(uuid)
      }
      const isVisible = getSubagentActivityVisible()
      // Render subagent prompt (text) or tool_result inside the subagent context
      for (const c of content) {
        if (c.type === 'text' && c.text?.trim()) {
          const article = this._makeBlock('cbr-block-subagent-activity')
          if (!isVisible) article.style.display = 'none'
          article.innerHTML =
            `<div class="cbr-subagent-activity-label">subagent input</div>` +
            `<pre class="cbr-pre cbr-tool-result-pre">${escHtml(c.text.slice(0, 2000))}${c.text.length > 2000 ? '\n…' : ''}</pre>`
          this._scroll.appendChild(article)
          this._scrollBottom()
        } else if (c.type === 'tool_result') {
          this._renderToolResultPart(c, { subagentActivity: true, visible: isVisible })
        }
      }
      return
    }

    // Normal user event (no parent): render text turns and tool results.
    for (const c of content) {
      if (c.type === 'text' && c.text?.trim()) {
        // History-replayed user turn (no nonce match above) — show user prompt
        this._appendUserBlock(c.text)
      } else if (c.type === 'tool_result') {
        // Tool output arrives as tool_result in the user turn following each tool_use.
        // This is the content that was previously invisible ("全是一条线" bug).
        this._renderToolResultPart(c)
      }
    }
  }

  _handleSystem(event) {
    if (event.subtype === 'init') {
      const toolCount = Array.isArray(event.tools) ? event.tools.length : '?'
      const sessionId = event.session_id ? event.session_id.slice(0, 8) + '…' : '—'
      this._addSystemBlock(`[Session ${sessionId} · ${toolCount} tools available]`)
    } else if (event.subtype === 'hook_started' || event.subtype === 'hook_response') {
      // Default: suppress hook noise. Debug mode could show them.
      // No-op intentionally.
    } else if (event.subtype === 'stderr') {
      this._addSystemBlock(`[stderr: ${event.text}]`)
    } else if (event.subtype === 'spawn_error') {
      this._addSystemBlock(`[Failed to start claude: ${event.text}]`)
    } else if (event.subtype === 'queued') {
      // Message was queued while server was busy — show feedback inline
      this._addSystemBlock(`[queued: ${event.text}]`)
    } else if (event.subtype === 'info') {
      this._addSystemBlock(`[${event.text}]`)
    }
  }

  _handleAssistant(event) {
    // Root F fix: do NOT return early for subagent events even when activity toggle is off.
    // Instead, build DOM with display:none so toggle can reveal it later.
    const isSubagentAssistant = !!event.parent_tool_use_id

    if (isSubagentAssistant) {
      // UUID dedup: history replay may resend subagent events; skip if already seen
      const uuid = event.uuid || (event.message && event.message.id)
      if (uuid) {
        if (this._seenSubagentUuids.has(uuid)) return
        this._seenSubagentUuids.add(uuid)
      }
      // Finalize subagent live block (independent from main agent live block)
      if (this._liveSubagentBlock) {
        this._liveSubagentBlock.style.opacity = ''
        this._liveSubagentBlock = null
      }

      const isVisible = getSubagentActivityVisible()
      const msg = event.message
      if (!msg || !Array.isArray(msg.content)) return

      // Root D risk: only clear liveToolBlocks that belong to this subagent level
      // (those marked with data-subagent-parent), not main agent tool blocks
      if (this._liveToolBlocks && this._liveToolBlocks.size > 0) {
        const parentId = event.parent_tool_use_id
        for (const [toolId, block] of this._liveToolBlocks.entries()) {
          if (block && block.dataset.subagentParent === parentId) {
            if (block.parentNode) block.parentNode.removeChild(block)
            this._liveToolBlocks.delete(toolId)
          }
        }
      }

      // Render each content part as an activity block
      for (const part of msg.content) {
        if (part.type === 'text') {
          if (!part.text?.trim()) continue
          const article = this._makeBlock('cbr-block-subagent-activity')
          if (!isVisible) article.style.display = 'none'
          let html
          try { html = renderMarkdown(part.text) } catch { html = `<p>${escHtml(part.text)}</p>` }
          article.innerHTML =
            `<div class="cbr-subagent-activity-label">subagent response</div>` +
            `<div class="cbr-text">${html}</div>`
          this._scroll.appendChild(article)
          this._scrollBottom()
        } else if (part.type === 'tool_use') {
          // Subagent's own tool calls — render as activity block
          const article = this._renderToolUsePart(part, { subagentActivity: true, visible: isVisible })
          if (article) {
            article.dataset.subagentParent = event.parent_tool_use_id
          }
        }
      }
      return
    }

    // ── Main agent assistant ────────────────────────────────────────────────────

    // Finalize main agent live block (does NOT touch _liveSubagentBlock)
    this._liveAssistantBlock = null
    this._liveAssistantId = null

    // Root D: clear live tool block map — only non-subagent tool blocks
    // (subagent tool blocks are marked with data-subagent-parent and handled above)
    if (this._liveToolBlocks && this._liveToolBlocks.size > 0) {
      for (const [toolId, block] of this._liveToolBlocks.entries()) {
        // Only remove blocks that are NOT subagent-owned
        if (block && !block.dataset.subagentParent) {
          if (block.parentNode) block.parentNode.removeChild(block)
          this._liveToolBlocks.delete(toolId)
        }
      }
    }

    const msg = event.message
    if (!msg || !Array.isArray(msg.content)) return

    for (const part of msg.content) {
      this._renderContentPart(part, /* live= */ false)
    }
  }

  _handlePartialMessage(event) {
    // Root F fix: do NOT return early for subagent partials even when activity toggle is off.
    // Build DOM with display:none so toggle can reveal blocks that already streamed through.
    const isSubagentPartial = !!event.parent_tool_use_id

    // partial_message carries a partial assistant message object
    const msg = event.message
    if (!msg || !Array.isArray(msg.content)) return

    const parts = msg.content

    // Root D: handle tool_use partials — show loading placeholder while streaming
    // We track live loading blocks by tool id in _liveToolBlocks map
    if (!this._liveToolBlocks) this._liveToolBlocks = new Map()

    const isVisible = isSubagentPartial ? getSubagentActivityVisible() : true

    for (const part of parts) {
      if (part.type === 'tool_use') {
        const toolId = part.id
        if (!toolId) continue
        if (!this._liveToolBlocks.has(toolId)) {
          // Create loading placeholder (input may be partial/incomplete JSON — safe to pass)
          const safePart = { name: part.name || 'tool', id: toolId, input: null }
          // Try to parse input if present (partial_json may arrive as a partial object)
          if (part.input != null) {
            try {
              // input is already parsed by Claude CLI if it's an object; just use it
              safePart.input = (typeof part.input === 'object') ? part.input : JSON.parse(part.input)
            } catch {
              safePart.input = null  // still incomplete JSON — stay loading
            }
          }
          const loadBlock = this._renderToolUsePart(safePart, {
            loading: safePart.input == null,
            subagentActivity: isSubagentPartial,
            visible: isVisible,
          })
          if (loadBlock && isSubagentPartial) {
            loadBlock.dataset.subagentParent = event.parent_tool_use_id
          }
          this._liveToolBlocks.set(toolId, loadBlock)
        }
        // Note: we don't update the block on each delta — the final `assistant` event
        // will render the completed tool_use block (or _handleAssistant will replace
        // the live block). The loading placeholder just provides immediate feedback.
      }
    }

    if (isSubagentPartial) {
      // Subagent partial text: update/create a single reused live subagent activity block
      // (risk point 4: reuse same block, don't create one per chunk)
      if (parts.length >= 1 && parts[0].type === 'text') {
        const text = parts[0].text || ''
        if (text.trim()) {
          if (!this._liveSubagentBlock) {
            const article = this._makeBlock('cbr-block-subagent-activity cbr-live')
            if (!isVisible) article.style.display = 'none'
            article.style.opacity = '0.7'
            article.innerHTML = `<div class="cbr-subagent-activity-label">subagent streaming…</div><div class="cbr-subagent-stream-body"></div>`
            this._scroll.appendChild(article)
            this._liveSubagentBlock = article
            this._scrollBottom()
          }
          const bodyEl = this._liveSubagentBlock.querySelector('.cbr-subagent-stream-body')
          if (bodyEl) {
            let html
            try { html = renderMarkdown(text) } catch { html = `<p>${escHtml(text)}</p>` }
            bodyEl.innerHTML = html
          }
          this._scrollBottom()
        }
      }
      return
    }

    // Main agent partial: live-update for the single-text-part case (existing behaviour)
    if (parts.length === 1 && parts[0].type === 'text') {
      const text = parts[0].text || ''
      if (!this._liveAssistantBlock) {
        const article = this._makeBlock('cbr-block-text cbr-live')
        this._scroll.appendChild(article)
        this._liveAssistantBlock = article
        this._scrollBottom()
      }
      let html
      try {
        html = renderMarkdown(text)
      } catch {
        html = `<p>${escHtml(text)}</p>`
      }
      this._liveAssistantBlock.innerHTML = `<div class="cbr-text">${html}</div>`
      this._scrollBottom()
    }
  }

  _handleResult(event) {
    // End-of-turn: flush live blocks, exit thinking state
    this._liveAssistantBlock = null
    this._liveAssistantId = null
    if (this._liveSubagentBlock) {
      this._liveSubagentBlock.style.opacity = ''
      this._liveSubagentBlock = null
    }
    this._setThinking(false)

    if (event.subtype === 'success' || event.subtype === 'error_max_turns') {
      const usage = event.usage
      if (usage) {
        const parts = []
        if (usage.input_tokens != null) parts.push(`in ${usage.input_tokens}`)
        if (usage.output_tokens != null) parts.push(`out ${usage.output_tokens}`)
        if (usage.cache_read_input_tokens != null) parts.push(`cache_read ${usage.cache_read_input_tokens}`)
        if (event.cost_usd != null) parts.push(`$${Number(event.cost_usd).toFixed(4)}`)
        if (parts.length) {
          const article = this._makeBlock('cbr-block-usage')
          article.innerHTML = `<p class="cbr-usage">${escHtml(parts.join(' · '))}</p>`
          this._scroll.appendChild(article)
          this._scrollBottom()
        }
      }
    } else if (event.subtype === 'error') {
      this._addSystemBlock(`[Error: ${event.error?.message || 'unknown error'}]`)
    }
  }

  _handleRateLimit(event) {
    const info = event.rate_limit_info || {}
    const msg = info.retryAfterMs
      ? `Rate limited — retry in ${(info.retryAfterMs / 1000).toFixed(0)}s`
      : 'Rate limit warning'
    // Show as a transient toast-like system block
    const article = this._makeBlock('cbr-block-system cbr-rate-limit')
    article.innerHTML = `<p class="cbr-system">[${escHtml(msg)}]</p>`
    this._scroll.appendChild(article)
    this._scrollBottom()
  }

  // ── Content rendering ──────────────────────────────────────────────────────

  _renderContentPart(part, live = false) {
    if (!part) return
    if (part.type === 'text') {
      this._renderTextPart(part.text || '', live)
    } else if (part.type === 'tool_use') {
      this._renderToolUsePart(part)
    } else if (part.type === 'tool_result') {
      this._renderToolResultPart(part)
    }
  }

  _renderTextPart(text, live) {
    if (!text.trim()) return
    const article = this._makeBlock('cbr-block-text' + (live ? ' cbr-live' : ''))
    let html
    try {
      html = renderMarkdown(text)
    } catch {
      html = `<p>${escHtml(text)}</p>`
    }
    article.innerHTML = `<div class="cbr-text">${html}</div>`
    attachCopyHandlers(article)
    this._scroll.appendChild(article)
    this._scrollBottom()
  }

  _renderToolUsePart(part, opts = {}) {
    const toolName = escHtml(part.name || 'tool')

    // ── Subagent prompt detection ─────────────────────────────────────────────
    // The Agent tool (and TaskCreate in some versions) represents dispatching a
    // subagent. Its input.prompt is the message we send to the subagent.
    // We also detect codex dispatches heuristically: a Bash tool_use whose command
    // contains "codex" or dispatches via tmux is treated as a subagent invocation
    // for toggle purposes. This is best-effort; a plain Bash tool running an
    // unrelated tmux command would not normally contain "codex" in its context.
    const isSubagentTool = part.name === 'Agent' || part.name === 'Task' || part.name === 'TaskCreate'
    const isBashCodexDispatch = part.name === 'Bash' && (
      (typeof part.input?.command === 'string' && /codex|dispatch.codex/i.test(part.input.command))
    )
    const isSubagentPrompt = isSubagentTool || isBashCodexDispatch

    // Root D: partial/loading state — input may be partial JSON or null
    const isLoading = opts.loading === true

    // Root F: subagentActivity flag means this tool block belongs to subagent internals
    // (not the prompt sent TO the subagent, but the subagent's own tool calls)
    const isSubagentActivity = opts.subagentActivity === true
    // visible: for subagent activity blocks, whether the activity toggle is on
    // (undefined means don't control visibility — for main agent blocks)
    const activityVisible = opts.visible

    let inputHtml = ''
    if (isLoading) {
      inputHtml = `<div class="cbr-tool-loading">running…</div>`
    } else if (part.input != null) {
      if (isSubagentTool) {
        // For subagent tools, show prompt and description in a more readable way
        const prompt = part.input.prompt || ''
        const description = part.input.description || ''
        if (description) {
          inputHtml += `<div class="cbr-subagent-desc">${escHtml(description)}</div>`
        }
        if (prompt) {
          inputHtml += `<pre class="cbr-pre cbr-subagent-prompt-text">${escHtml(prompt.slice(0, 3000))}${prompt.length > 3000 ? '\n…' : ''}</pre>`
        }
        if (!description && !prompt) {
          try {
            inputHtml = renderCode(JSON.stringify(part.input, null, 2), 'json')
          } catch {
            inputHtml = `<pre class="cbr-pre"><code>${escHtml(String(part.input))}</code></pre>`
          }
        }
      } else {
        try {
          const pretty = JSON.stringify(part.input, null, 2)
          inputHtml = renderCode(pretty, 'json')
        } catch {
          inputHtml = `<pre class="cbr-pre"><code>${escHtml(String(part.input))}</code></pre>`
        }
      }
    }

    const extraClass = isSubagentPrompt ? ' cbr-block-subagent-prompt' : ''
    const activityClass = isSubagentActivity ? ' cbr-block-subagent-activity' : ''
    const loadingClass = isLoading ? ' cbr-tool-loading-state' : ''
    const article = this._makeBlock('cbr-block-tool' + extraClass + activityClass + loadingClass)

    // Root A: stamp data-tool-id so tool_result can find this block by tool_use_id
    if (part.id) {
      article.setAttribute('data-tool-id', part.id)
    }

    article.innerHTML =
      `<div class="cbr-tool-card">` +
      `<div class="cbr-tool-header">` +
      `<span class="cbr-tool-name">${toolName}</span>` +
      (isSubagentTool ? `<span class="cbr-subagent-badge">subagent</span>` : '') +
      (isLoading ? `<span class="cbr-tool-running-badge">running…</span>` : '') +
      `<button class="cbr-tool-fold-btn" title="Toggle fold" aria-label="Toggle fold">` +
      `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>` +
      `</button>` +
      `</div>` +
      `<div class="cbr-tool-body">${inputHtml}</div>` +
      `<div class="cbr-tool-output"></div>` +
      `</div>`

    // Apply subagent-prompt visibility
    if (isSubagentPrompt && !getSubagentPromptVisible()) {
      article.style.display = 'none'
    }

    // Root F: apply subagent-activity visibility (for tool blocks inside subagent internals)
    if (isSubagentActivity && activityVisible === false) {
      article.style.display = 'none'
    }

    // Clicking anywhere on the article (including the ::before stripe in line mode)
    // cycles through all three fold states: full → header → line → full.
    // The handler lives on the article root so it is ALWAYS reachable even when
    // the inner card is hidden (line state).
    article.style.cursor = 'pointer'
    article.addEventListener('click', (e) => {
      // Suppress if the user is clicking a copy button or interactive element
      // inside the card (but still allow clicks on the fold button or header).
      const target = e.target
      if (target.closest('.cbr-copy-btn') || target.closest('a') || target.tagName === 'A') return
      const cur = article.getAttribute('data-fold') || getToolFoldLevel()
      // Cycle: full → header → line → full
      const idx = TOOL_FOLD_LEVELS.indexOf(cur)
      const next = TOOL_FOLD_LEVELS[(idx + 1) % TOOL_FOLD_LEVELS.length]
      article.setAttribute('data-fold', next)
    })
    // Subagent-prompt blocks: always start at 'full' so the prompt text is
    // visible even when the global tool-fold level is 'header' or 'line'.
    // Without this the user enables the toggle and the block appears but the
    // body is folded away by the global fold CSS — confusingly blank.
    if (isSubagentPrompt) {
      article.setAttribute('data-fold', 'full')
    } else {
      applyToolFold(article)
    }
    attachCopyHandlers(article)
    this._scroll.appendChild(article)
    this._scrollBottom()
    return article
  }

  _renderToolResultPart(part, opts = {}) {
    // tool_result: show output, paired with the originating tool_use block if possible
    const content = part.content
    const isError = part.is_error === true  // Root C: read is_error flag
    // Root F: for subagent activity tool results, fallback block should respect visibility toggle
    const isSubagentActivity = opts.subagentActivity === true
    const activityVisible = opts.visible

    // Root B: build display text; handle string, array (text+image), and empty content
    let text = ''
    let hasImage = false
    if (typeof content === 'string') {
      text = content
    } else if (Array.isArray(content)) {
      const textParts = content.filter((c) => c.type === 'text').map((c) => c.text)
      text = textParts.join('\n')
      hasImage = content.some((c) => c.type === 'image')
    }
    // Root B: do NOT silently return on empty/non-text content — always show something
    const displayText = text.trim()
      ? text
      : hasImage
        ? '(image result)'
        : content == null
          ? '(no result)'
          : '(empty result)'

    const truncated = displayText.length > 2000
    const displaySlice = truncated ? displayText.slice(0, 2000) + '\n…' : displayText

    // Root C: add error class when is_error is true
    const errorClass = isError ? ' cbr-tool-result--error' : ''

    const resultHtml =
      `<div class="cbr-tool-result${errorClass}">` +
      (isError ? `<div class="cbr-tool-result-error-label">tool error</div>` : '') +
      `<pre class="cbr-pre cbr-tool-result-pre">${escHtml(displaySlice)}</pre>` +
      `</div>`

    // Root A: try to pair with the originating tool_use block by tool_use_id
    const toolUseId = part.tool_use_id
    let paired = false
    if (toolUseId) {
      const toolBlock = this._scroll.querySelector(`[data-tool-id="${CSS.escape(toolUseId)}"]`)
      if (toolBlock) {
        // Remove loading state badge/class
        toolBlock.classList.remove('cbr-tool-loading-state')
        const runningBadge = toolBlock.querySelector('.cbr-tool-running-badge')
        if (runningBadge) runningBadge.remove()

        // Inject result into the .cbr-tool-output section of the existing tool block
        const outputDiv = toolBlock.querySelector('.cbr-tool-output')
        if (outputDiv) {
          outputDiv.innerHTML = resultHtml
          // No inline display override needed — CSS controls visibility via data-fold
          // Add error border to the whole tool block if is_error
          if (isError) toolBlock.classList.add('cbr-tool-block--error')
          attachCopyHandlers(outputDiv)
          paired = true
        }
      }
    }

    // Fallback (Root A): if no matching tool block, render as standalone result block
    if (!paired) {
      const extraClass = isSubagentActivity ? ' cbr-block-subagent-activity' : ''
      const article = this._makeBlock('cbr-block-tool-result' + extraClass)
      if (isSubagentActivity && activityVisible === false) {
        article.style.display = 'none'
      }
      article.innerHTML = resultHtml
      applyToolFold(article)
      this._scroll.appendChild(article)
      this._scrollBottom()
    }
  }

  // ── Utility blocks ─────────────────────────────────────────────────────────

  _makeBlock(extraClasses = '') {
    const article = document.createElement('article')
    article.className = `cbr-block ${extraClasses}`.trim()
    return article
  }

  _addSystemBlock(msg) {
    const article = this._makeBlock('cbr-block-system')
    article.innerHTML = `<p class="cbr-system">${escHtml(msg)}</p>`
    this._scroll.appendChild(article)
    this._scrollBottom()
  }

  _appendUserBlock(text) {
    const article = this._makeBlock('cbr-block-prompt cbr-user-prompt')
    article.innerHTML = `<p class="cbr-prompt-text">&#10095; ${escHtml(text)}</p>`
    this._scroll.appendChild(article)
    this._scrollBottom()
  }

  _scrollBottom() {
    requestAnimationFrame(() => {
      this._scroll.scrollTop = this._scroll.scrollHeight
      // After programmatic scroll, re-evaluate button visibility
      this._updateScrollBtn()
    })
  }
}

// Export fold helpers and subagent visibility helpers so settings panel (app.js) can wire them up
export {
  getToolFoldLevel, setToolFoldLevel, TOOL_FOLD_LEVELS,
  getSubagentPromptVisible, setSubagentPromptVisible,
  getSubagentActivityVisible, setSubagentActivityVisible,
}
