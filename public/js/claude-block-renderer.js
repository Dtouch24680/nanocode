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
  // Apply immediately to all existing subagent-prompt blocks
  document.querySelectorAll('.cbr-block-subagent-prompt').forEach((el) => {
    el.style.display = val ? '' : 'none'
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
        this._pendingNonces = new Set()
        this._thinking = false
        this._addSystemBlock('[Reconnected. Restoring session history…]')
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

  _handleEvent(event) {
    if (!event || !event.type) return

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

    const content = event.message?.content
    if (!Array.isArray(content)) return

    // Subagent activity: events with parent_tool_use_id are messages TO a subagent
    // or results FROM a subagent. Visibility controlled by the subagent-activity toggle.
    const parentToolUseId = event.parent_tool_use_id
    if (parentToolUseId) {
      if (!getSubagentActivityVisible()) return
      // Render subagent prompt (text) or tool_result inside the subagent context
      for (const c of content) {
        if (c.type === 'text' && c.text?.trim()) {
          const article = this._makeBlock('cbr-block-subagent-activity')
          article.innerHTML =
            `<div class="cbr-subagent-activity-label">subagent input</div>` +
            `<pre class="cbr-pre cbr-tool-result-pre">${escHtml(c.text.slice(0, 2000))}${c.text.length > 2000 ? '\n…' : ''}</pre>`
          this._scroll.appendChild(article)
          this._scrollBottom()
        } else if (c.type === 'tool_result') {
          this._renderToolResultPart(c)
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
    }
  }

  _handleAssistant(event) {
    // Finalize any in-progress live block
    this._liveAssistantBlock = null
    this._liveAssistantId = null

    const msg = event.message
    if (!msg || !Array.isArray(msg.content)) return

    for (const part of msg.content) {
      this._renderContentPart(part, /* live= */ false)
    }
  }

  _handlePartialMessage(event) {
    // partial_message carries a partial assistant message object
    const msg = event.message
    if (!msg || !Array.isArray(msg.content)) return

    // We only do live-update for the simplest case: a single text part.
    // Tool-use partials are rendered as they arrive.
    const parts = msg.content
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
    // Multi-part partials: just let the final `assistant` event render them.
  }

  _handleResult(event) {
    // End-of-turn: flush live block, exit thinking state
    this._liveAssistantBlock = null
    this._liveAssistantId = null
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

  _renderToolUsePart(part) {
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

    let inputHtml = ''
    if (part.input != null) {
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
    const article = this._makeBlock('cbr-block-tool' + extraClass)
    article.innerHTML =
      `<div class="cbr-tool-card">` +
      `<div class="cbr-tool-header">` +
      `<span class="cbr-tool-name">${toolName}</span>` +
      (isSubagentTool ? `<span class="cbr-subagent-badge">subagent</span>` : '') +
      `<button class="cbr-tool-fold-btn" title="Toggle fold" aria-label="Toggle fold">` +
      `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>` +
      `</button>` +
      `</div>` +
      `<div class="cbr-tool-body">${inputHtml}</div>` +
      `</div>`

    // Apply subagent-prompt visibility
    if (isSubagentPrompt && !getSubagentPromptVisible()) {
      article.style.display = 'none'
    }

    // Clicking the header (or fold button) manually toggles between full↔header
    const header = article.querySelector('.cbr-tool-header')
    if (header) {
      header.style.cursor = 'pointer'
      header.addEventListener('click', () => {
        const cur = article.getAttribute('data-fold') || getToolFoldLevel()
        // local per-block toggle: full→header→full (single block, not global)
        const next = cur === 'full' ? 'header' : 'full'
        article.setAttribute('data-fold', next)
      })
    }
    applyToolFold(article)
    attachCopyHandlers(article)
    this._scroll.appendChild(article)
    this._scrollBottom()
  }

  _renderToolResultPart(part) {
    // tool_result: show output compactly
    const content = part.content
    if (!content) return
    let text = ''
    if (typeof content === 'string') {
      text = content
    } else if (Array.isArray(content)) {
      text = content.filter((c) => c.type === 'text').map((c) => c.text).join('\n')
    }
    if (!text.trim()) return
    const article = this._makeBlock('cbr-block-tool-result')
    article.innerHTML =
      `<div class="cbr-tool-result">` +
      `<pre class="cbr-pre cbr-tool-result-pre">${escHtml(text.slice(0, 2000))}${text.length > 2000 ? '\n…' : ''}</pre>` +
      `</div>`
    applyToolFold(article)
    this._scroll.appendChild(article)
    this._scrollBottom()
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
