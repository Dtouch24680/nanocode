/**
 * CodexBlockRenderer — PTY-output block renderer for Codex CLI tabs.
 *
 * Codex CLI outputs raw ANSI/PTY text (unlike Claude which outputs structured
 * JSON events). This renderer intercepts the PTY output stream, strips ANSI
 * escape codes, and detects Codex-specific patterns to render visual blocks
 * with fold states similar to ClaudeBlockRenderer.
 *
 * Detected block types:
 *   - bash_command  — lines starting with "$ " or indented command execution
 *   - bash_output   — stdout/stderr following a bash block
 *   - status_banner — "Working Xm Ys" / "Thinking…" / completion messages
 *   - exit_code     — exit code / error indicators
 *   - text          — general codex reasoning/response text
 *
 * Public API mirrors TerminalPane:
 *   new CodexBlockRenderer(container, { projectId, tabId, onStatusChange })
 *   .sendInputWithEcho(text)
 *   .sendRaw(data)
 *   .fitAddon  — stub { fit: () => {} }
 *   .dispose()
 */

// ── WS constants ──────────────────────────────────────────────────────────────
const WS_PATH = '/ws/terminal'
const BACKOFF_BASE = 500
const BACKOFF_MAX = 10_000
const PING_INTERVAL_MS = 5000

// ── Fold constants ─────────────────────────────────────────────────────────────
const FOLD_KEY = 'cbx_tool_fold'
const FOLD_LEVELS = ['full', 'header', 'line']

function getFoldLevel() {
  const v = localStorage.getItem(FOLD_KEY)
  return FOLD_LEVELS.includes(v) ? v : 'full'
}

// ── ANSI strip ────────────────────────────────────────────────────────────────
const ANSI_RE = /\x1b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g

function stripAnsi(s) {
  return s.replace(ANSI_RE, '')
}

// ── HTML escape ───────────────────────────────────────────────────────────────
function escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// ── URL auto-link ─────────────────────────────────────────────────────────────
const URL_RE = /https?:\/\/[^\s"'<>[\]()]+[^\s"'<>[\]().,;:!?]/g

function linkifyText(text) {
  const safe = escHtml(text)
  return safe.replace(URL_RE, (url) => {
    return `<a href="${url}" target="_blank" rel="noopener noreferrer" class="cbx-url">${url}</a>`
  })
}

// ── Pattern detection ─────────────────────────────────────────────────────────
// Codex outputs several distinct line patterns.

// "Working 2m 15s" / "Working..." spinner lines
const STATUS_BANNER_RE = /^(?:Working|Thinking|Analyzing|Planning|Running|Executing|Reviewing)[\s.…]*/i

// Bash command line: codex often shows commands like:
//   $ cmd
//   > cmd (alternative)
//   Running: cmd
//   Executing: cmd
//   bash: cmd
const BASH_CMD_RE = /^(?:\$\s+|>\s+|Running:\s+|Executing:\s+|bash:\s+|cmd:\s+)/i

// Exit status line: "Exit code: 0" / "exit 0" / "✓ Command succeeded" / "✗ Error"
const EXIT_STATUS_RE = /^(?:exit\s+code\s*[:=]?\s*(\d+)|exit\s+(\d+)|✓|✗|Error:|error:)/i

// apply_patch or file edit patterns
const PATCH_RE = /^(?:apply_patch|edit_file|write_file|create_file|patch:)/i

// Codex "turn" separator
const TURN_SEP_RE = /^[─═]{10,}/

// ── Main class ────────────────────────────────────────────────────────────────
export class CodexBlockRenderer {
  constructor(container, opts = {}) {
    this.container = container
    this.projectId = opts.projectId
    this.tabId = opts.tabId
    this.onStatusChange = opts.onStatusChange || (() => {})

    this.fitAddon = { fit: () => {} }

    container.classList.add('cbx-container')
    this._scroll = document.createElement('div')
    this._scroll.className = 'cbx-scroll'
    container.appendChild(this._scroll)

    // Scroll-to-bottom button
    this._scrollBtn = document.createElement('button')
    this._scrollBtn.className = 'cbr-scroll-to-bottom'
    this._scrollBtn.setAttribute('aria-label', 'Scroll to bottom')
    this._scrollBtn.innerHTML =
      `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">` +
      `<polyline points="6 9 12 15 18 9"/></svg>`
    this._scrollBtn.addEventListener('click', () => {
      this._scroll.scrollTo({ top: this._scroll.scrollHeight, behavior: 'smooth' })
    })
    container.appendChild(this._scrollBtn)

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

    // Raw PTY buffer — accumulate until we see a newline boundary
    this._ptybuf = ''

    // Current active bash block being built
    this._currentBashBlock = null

    // Status banner element (overwritten with each update)
    this._statusBannerEl = null

    // Track thinking state
    this._thinking = false

    this._connect()
  }

  _updateScrollBtn() {
    const s = this._scroll
    const atBottom = s.scrollHeight - s.scrollTop - s.clientHeight < 60
    this._scrollBtn.classList.toggle('cbr-scroll-btn-visible', !atBottom)
  }

  isThinking() { return this._thinking }

  _setThinking(val) {
    if (this._thinking === val) return
    this._thinking = val
    document.dispatchEvent(new CustomEvent('nanocode:claude-thinking', {
      detail: { tabId: this.tabId, thinking: val },
    }))
  }

  // ── Public API ───────────────────────────────────────────────────────────────

  sendInputWithEcho(text) {
    // Show user input as a prompt block
    this._finalizeCurrentBlock()
    this._appendUserBlock(text)
    this._send({ type: 'input', data: text + '\r' })
    this._setThinking(true)
  }

  sendRaw(data) {
    if (data === '\x03') {
      this._addSystemBlock('[Interrupted]')
      this._send({ type: 'input', data })
    }
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
      const { cols, rows } = this._dimensions()
      this._send({
        type: 'attach',
        projectId: this.projectId,
        sessionType: 'bash',
        tabId: this.tabId,
        cols,
        rows,
      })
      this._startPing()
    }

    this._ws.onmessage = (e) => {
      let msg
      try { msg = JSON.parse(e.data) } catch { return }

      if (msg.type === 'history') {
        // Replay historical PTY data
        if (msg.data) this._handlePtyData(msg.data, true)
      } else if (msg.type === 'output') {
        this._handlePtyData(msg.data, false)
        document.dispatchEvent(new CustomEvent('nanocode:terminal-output', { detail: msg.data }))
      } else if (msg.type === 'exit') {
        this._exited = true
        this._setThinking(false)
        this._finalizeCurrentBlock()
        this._addSystemBlock(`[Codex exited (code ${msg.exitCode ?? '?'}). Send a message to start a new session.]`)
      } else if (msg.type === 'error') {
        this._addSystemBlock('[Error: ' + (msg.error || 'unknown') + ']')
      } else if (msg.type === 'pong') {
        // ignore
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
      return true
    }
    return false
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

  _dimensions() {
    // Default dims — codex doesn't need precise terminal sizing
    return { cols: 200, rows: 50 }
  }

  // ── PTY data handling ─────────────────────────────────────────────────────────

  /**
   * Process raw PTY data. We accumulate in a buffer and split on newlines.
   * Each complete line is processed to detect codex patterns.
   */
  _handlePtyData(data, fromHistory) {
    if (!data) return
    // Strip ANSI codes first
    const cleaned = stripAnsi(data)
    // Accumulate in buffer
    this._ptybuf += cleaned

    // Process complete lines
    const lines = this._ptybuf.split('\n')
    // Keep last (potentially incomplete) line in buffer
    this._ptybuf = lines.pop() ?? ''

    for (const line of lines) {
      this._processLine(line.replace(/\r/g, ''))
    }
  }

  _processLine(line) {
    if (!line.trim()) {
      // Blank line: may indicate block boundary
      if (this._currentBashBlock) {
        // Add blank line to current bash output
        this._appendToBashOutput('\n')
      }
      return
    }

    // Status banner (Working / Thinking) — update in-place
    if (STATUS_BANNER_RE.test(line)) {
      this._updateStatusBanner(line.trim())
      this._setThinking(true)
      return
    }

    // Turn separator ─────────
    if (TURN_SEP_RE.test(line)) {
      this._finalizeCurrentBlock()
      this._setThinking(false)
      this._statusBannerEl = null
      return
    }

    // Bash command line
    if (BASH_CMD_RE.test(line)) {
      this._finalizeCurrentBlock()
      const cmd = line.replace(BASH_CMD_RE, '').trim()
      this._startBashBlock(cmd)
      return
    }

    // Exit status line
    if (EXIT_STATUS_RE.test(line)) {
      if (this._currentBashBlock) {
        this._finalizeBashBlockWithExit(line.trim())
      } else {
        this._finalizeCurrentBlock()
        this._addExitStatusBlock(line.trim())
      }
      return
    }

    // Patch/file edit
    if (PATCH_RE.test(line)) {
      this._finalizeCurrentBlock()
      this._addPatchBlock(line.trim())
      return
    }

    // If we're inside a bash block, this is output
    if (this._currentBashBlock) {
      this._appendToBashOutput(line)
      return
    }

    // General text — show as response text
    this._appendTextLine(line)
  }

  // ── Block builders ────────────────────────────────────────────────────────────

  _startBashBlock(cmd) {
    // Clear any stale status banner
    if (this._statusBannerEl) {
      this._statusBannerEl.remove()
      this._statusBannerEl = null
    }

    const article = this._makeBlock('cbx-block-bash')
    const foldLevel = getFoldLevel()
    article.setAttribute('data-fold', foldLevel)

    const cmdHtml = `<code class="cbx-bash-cmd">${escHtml(cmd)}</code>`

    article.innerHTML =
      `<div class="cbx-bash-card">` +
      `<div class="cbx-bash-header">` +
      `<span class="cbx-bash-icon">$</span>` +
      `<span class="cbx-bash-cmd-text">${cmdHtml}</span>` +
      `<span class="cbx-bash-status cbx-bash-running">running…</span>` +
      `<button class="cbx-fold-btn" title="Toggle fold" aria-label="Toggle fold">` +
      `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>` +
      `</button>` +
      `</div>` +
      `<pre class="cbx-bash-output cbx-bash-body"></pre>` +
      `</div>`

    // Fold click on header cycles fold states
    const header = article.querySelector('.cbx-bash-header')
    header.addEventListener('click', (e) => {
      if (e.target.closest('a') || e.target.tagName === 'A') return
      const cur = article.getAttribute('data-fold') || getFoldLevel()
      const idx = FOLD_LEVELS.indexOf(cur)
      const next = FOLD_LEVELS[(idx + 1) % FOLD_LEVELS.length]
      article.setAttribute('data-fold', next)
    })
    article.style.cursor = 'pointer'

    this._scroll.appendChild(article)
    this._scrollBottom()

    this._currentBashBlock = {
      article,
      cmd,
      outputEl: article.querySelector('.cbx-bash-output'),
      outputLines: [],
    }
  }

  _appendToBashOutput(line) {
    if (!this._currentBashBlock) return
    this._currentBashBlock.outputLines.push(line)
    // Limit display to 2000 chars per block to prevent DOM bloat
    const text = this._currentBashBlock.outputLines.join('\n')
    const truncated = text.length > 3000
    const display = truncated ? text.slice(0, 3000) + '\n…[truncated]' : text
    this._currentBashBlock.outputEl.textContent = display
    this._scrollBottom()
  }

  _finalizeBashBlockWithExit(exitLine) {
    if (!this._currentBashBlock) return
    const { article } = this._currentBashBlock
    const statusEl = article.querySelector('.cbx-bash-status')

    const isError = /\✗|[Ee]rror|exit\s+[1-9]/.test(exitLine)
    const exitCode = exitLine.match(/\d+/)?.[0] ?? '?'
    const isSuccess = !isError && (exitLine.includes('✓') || exitCode === '0')

    if (statusEl) {
      statusEl.classList.remove('cbx-bash-running')
      if (isSuccess) {
        statusEl.className = 'cbx-bash-status cbx-bash-ok'
        statusEl.textContent = '✓ exit 0'
      } else {
        statusEl.className = 'cbx-bash-status cbx-bash-err'
        statusEl.textContent = `✗ exit ${exitCode}`
      }
    }

    this._currentBashBlock = null
    this._setThinking(false)
  }

  _finalizeCurrentBlock() {
    if (!this._currentBashBlock) return
    const { article } = this._currentBashBlock
    const statusEl = article.querySelector('.cbx-bash-status')
    if (statusEl && statusEl.classList.contains('cbx-bash-running')) {
      statusEl.classList.remove('cbx-bash-running')
      statusEl.className = 'cbx-bash-status cbx-bash-done'
      statusEl.textContent = 'done'
    }
    this._currentBashBlock = null
  }

  _updateStatusBanner(text) {
    if (!this._statusBannerEl) {
      // Create banner
      const el = document.createElement('div')
      el.className = 'cbx-status-banner'
      this._scroll.appendChild(el)
      this._statusBannerEl = el
    }
    this._statusBannerEl.innerHTML =
      `<span class="cbx-status-spinner"></span>` +
      `<span class="cbx-status-text">${escHtml(text)}</span>`
    this._scrollBottom()
  }

  _addExitStatusBlock(line) {
    const isError = /\✗|[Ee]rror|exit\s+[1-9]/.test(line)
    const article = this._makeBlock('cbx-block-exit')
    article.innerHTML =
      `<span class="cbx-exit-badge ${isError ? 'cbx-exit-err' : 'cbx-exit-ok'}">` +
      `${escHtml(line)}` +
      `</span>`
    this._scroll.appendChild(article)
    this._scrollBottom()
  }

  _addPatchBlock(line) {
    const article = this._makeBlock('cbx-block-patch')
    article.setAttribute('data-fold', getFoldLevel())
    article.innerHTML =
      `<div class="cbx-patch-header">` +
      `<span class="cbx-patch-icon">✏</span>` +
      `<span class="cbx-patch-label">${escHtml(line)}</span>` +
      `</div>`
    article.addEventListener('click', () => {
      const cur = article.getAttribute('data-fold') || getFoldLevel()
      const idx = FOLD_LEVELS.indexOf(cur)
      const next = FOLD_LEVELS[(idx + 1) % FOLD_LEVELS.length]
      article.setAttribute('data-fold', next)
    })
    this._scroll.appendChild(article)
    this._scrollBottom()
  }

  _appendTextLine(line) {
    // Clear status banner since we got actual text
    if (this._statusBannerEl) {
      this._statusBannerEl.remove()
      this._statusBannerEl = null
    }

    // Check if last block is a text block we can append to
    const last = this._scroll.lastElementChild
    if (last && last.classList.contains('cbx-block-text')) {
      const pre = last.querySelector('.cbx-text-pre')
      if (pre) {
        pre.textContent += '\n' + line
        this._scrollBottom()
        return
      }
    }

    // Create new text block
    const article = this._makeBlock('cbx-block-text')
    const pre = document.createElement('pre')
    pre.className = 'cbx-text-pre'
    pre.textContent = line
    article.appendChild(pre)
    this._scroll.appendChild(article)
    this._scrollBottom()
  }

  // ── Utility blocks ────────────────────────────────────────────────────────────

  _makeBlock(extraClasses = '') {
    const article = document.createElement('article')
    article.className = `cbx-block ${extraClasses}`.trim()
    return article
  }

  _addSystemBlock(msg) {
    const article = this._makeBlock('cbx-block-system')
    article.innerHTML = `<p class="cbx-system">${escHtml(msg)}</p>`
    this._scroll.appendChild(article)
    this._scrollBottom()
  }

  _appendUserBlock(text) {
    const article = this._makeBlock('cbx-block-user')
    article.innerHTML = `<p class="cbx-user-prompt">&#10095; ${escHtml(text)}</p>`
    this._scroll.appendChild(article)
    this._scrollBottom()
  }

  _scrollBottom() {
    requestAnimationFrame(() => {
      this._scroll.scrollTop = this._scroll.scrollHeight
      this._updateScrollBtn()
    })
  }
}
