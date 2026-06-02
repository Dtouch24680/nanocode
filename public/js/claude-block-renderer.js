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

    this._ws = null
    this._exited = false
    this._reconnectAttempts = 0
    this._reconnectTimer = null
    this._pingInterval = null

    // Track the in-progress assistant message block (partial_message updates)
    this._liveAssistantBlock = null
    this._liveAssistantId = null  // message id if available

    this._connect()
  }

  // ── Public API ───────────────────────────────────────────────────────────────

  sendInputWithEcho(text) {
    this._appendUserBlock(text)
    this._send({ type: 'claude-input', text })
    // Clear any live assistant block so next response starts fresh
    this._liveAssistantBlock = null
    this._liveAssistantId = null
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
      this._reconnectAttempts = 0
      this.onStatusChange(true)
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
      // user echo events from stream-json — skip, we already echoed locally
      case 'user':
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
    // End-of-turn: flush live block
    this._liveAssistantBlock = null
    this._liveAssistantId = null

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
    let inputHtml = ''
    if (part.input != null) {
      try {
        const pretty = JSON.stringify(part.input, null, 2)
        inputHtml = renderCode(pretty, 'json')
      } catch {
        inputHtml = `<pre class="cbr-pre"><code>${escHtml(String(part.input))}</code></pre>`
      }
    }
    const article = this._makeBlock('cbr-block-tool')
    article.innerHTML =
      `<div class="cbr-tool-card">` +
      `<div class="cbr-tool-header"><span class="cbr-tool-name">${toolName}</span></div>` +
      `<div class="cbr-tool-body">${inputHtml}</div>` +
      `</div>`
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
    })
  }
}
