/**
 * TerminalPane — reusable xterm + WebSocket + PTY bridge.
 * Optimized for high-latency / low-bandwidth networks.
 */

import { LocalEcho } from './local-echo.js'

const { Terminal } = window
const { FitAddon } = window.FitAddon
const { WebLinksAddon } = window.WebLinksAddon

const THEME = {
  background: '#0a0b0c',
  foreground: '#f0f0f0',
  cursor: '#8cc63f',
  cursorAccent: '#0a0b0c',
  selectionBackground: 'rgba(140, 198, 63, 0.2)',
  selectionForeground: '#f0f0f0',
  black: '#1a1b1e',
  red: '#ff6b6b',
  green: '#8cc63f',
  yellow: '#fbbf24',
  blue: '#60a5fa',
  magenta: '#c4b5fd',
  cyan: '#67e8f9',
  white: '#f0f0f0',
  brightBlack: '#555555',
  brightRed: '#ff8a8a',
  brightGreen: '#a3d856',
  brightYellow: '#fcd34d',
  brightBlue: '#93c5fd',
  brightMagenta: '#ddd6fe',
  brightCyan: '#a5f3fc',
  brightWhite: '#ffffff',
}

// Reconnect backoff: 500ms → 1s → 2s → 4s → 8s → 10s cap
const BACKOFF_BASE = 500
const BACKOFF_MAX = 10000

// Debounce resize messages — on drag, dozens fire per second.
// Only the final size matters.
const RESIZE_DEBOUNCE_MS = 80

// Latency measurement for adaptive local echo
const PING_INTERVAL_MS = 5000
const RTT_EWMA_ALPHA = 0.2
const LOCAL_ECHO_ENABLE_RTT_MS = 50
const LOCAL_ECHO_DISABLE_RTT_MS = 30

// Single WebSocket endpoint for all sessions
const WS_PATH = '/ws/terminal'

export class TerminalPane {
  /**
   * @param {HTMLElement} container — the .pane-terminal element
   * @param {{ projectId: string, sessionType: 'bash'|'claude', claudeSessionId?: string, onStatusChange?: (connected: boolean) => void }} opts
   */
  constructor(container, opts = {}) {
    this.container = container
    this.projectId = opts.projectId
    this.sessionType = opts.sessionType
    this.claudeSessionId = opts.claudeSessionId ?? ''
    this.cliProvider = opts.cliProvider || 'claude'
    this.onStatusChange = opts.onStatusChange || (() => {})

    this._ws = null
    this._exited = false
    this._reconnectAttempts = 0
    this._reconnectTimer = null
    this._resizeTimer = null
    this._pingInterval = null
    this._rttEwma = null

    // Create xterm — reduced scrollback saves memory on constrained clients
    const mobile = window.matchMedia('(max-width: 768px)').matches
    this.term = new Terminal({
      theme: THEME,
      fontFamily: "'JetBrains Mono', 'SF Mono', ui-monospace, monospace",
      fontSize: mobile ? 13 : 14,
      scrollback: mobile ? 2000 : 4000,
      cursorBlink: true,
      allowProposedApi: true,
    })

    // Addons — fit + web-links only (WebGL loaded lazily below)
    this.fitAddon = new FitAddon()
    this.term.loadAddon(this.fitAddon)
    this.term.loadAddon(new WebLinksAddon())

    // Local echo for high-latency: show typed chars immediately, reconcile with server output
    this.localEcho = new LocalEcho({
      write: (s) => this.term.write(s),
    })

    // Open in container
    this.term.open(container)

    // Lazy-load WebGL renderer — not on the critical path.
    // Terminal is usable immediately with canvas; WebGL loads in background.
    this._loadWebGL()

    // Mobile: fix touch scrolling — xterm.js sets inline touch-action:none on
    // .xterm-screen which blocks all touch gestures. Override it and add manual
    // touch scroll handling for the viewport.
    if (mobile) {
      this._initTouchScroll(container)
    }

    // Initial fit
    requestAnimationFrame(() => this._fit())

    // Resize observer — debounced to avoid flooding WS on drag
    this._resizeObserver = new ResizeObserver(() => {
      clearTimeout(this._resizeTimer)
      this._resizeTimer = setTimeout(() => this._fit(), RESIZE_DEBOUNCE_MS)
    })
    this._resizeObserver.observe(container)

    // Terminal input → WS (with local echo when enabled — instant feedback on high latency)
    this._dataDisposable = this.term.onData((data) => {
      // Filter out focus report sequences (CSI I / CSI O). xterm.js emits these
      // via onData when a program enables focus tracking mode (DECSET 1004) and
      // the terminal gains or loses focus. Forwarding them to the PTY causes
      // literal "[I" / "[O" to appear when clicking outside the terminal region.
      if (data === '\x1b[I' || data === '\x1b[O') return

      if (this._exited) {
        if (data === '\r') {
          const { cols, rows } = this._dimensions()
          this._send({ type: 'restart', cols, rows })
          this._exited = false
        }
        return
      }
      const echo = this.localEcho.predict(data)
      if (echo) this.term.write(echo)
      this._send({ type: 'input', data })
    })

    // Paste handler — Ctrl+V / Ctrl+Shift+V
    this._keyDisposable = this.term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true
      if ((e.ctrlKey || e.metaKey) && (e.key === 'v' || e.key === 'V')) {
        navigator.clipboard
          .readText()
          .then((text) => {
            if (text) this._send({ type: 'input', data: text })
          })
          .catch(() => {})
        return false
      }
      return true
    })

    // Connect
    this._connect()
  }

  /** Lazy-load WebGL addon — saves ~100KB from the critical render path */
  async _loadWebGL() {
    // Skip WebGL on mobile — canvas rendering is fine and saves resources
    if (window.matchMedia('(max-width: 768px)').matches) return
    try {
      // WebglAddon may already be on window from a sync script tag,
      // but if we removed it from HTML for lazy loading, fetch it.
      if (window.WebglAddon) {
        this.term.loadAddon(new window.WebglAddon.WebglAddon())
      }
    } catch {
      // canvas fallback is fine
    }
  }

  /**
   * Fix touch scrolling on mobile. xterm.js sets inline touch-action:none on
   * .xterm-screen which blocks all touch gestures. We override that and handle
   * vertical swipes by scrolling the terminal programmatically.
   */
  _initTouchScroll(container) {
    // Remove xterm's inline touch-action:none on the screen element
    const screen = container.querySelector('.xterm-screen')
    if (screen) {
      screen.style.touchAction = 'none'
    }

    // Also lock the viewport — we handle scrolling ourselves
    const viewport = container.querySelector('.xterm-viewport')
    if (viewport) {
      viewport.style.touchAction = 'none'
      viewport.style.overscrollBehavior = 'none'
    }

    // Manual touch scroll — intercept vertical swipes, scroll the terminal,
    // and preventDefault to stop iOS from also scrolling the page.
    let touchStartY = 0
    let touchActive = false
    let accumDy = 0

    container.addEventListener('touchstart', (e) => {
      if (e.touches.length !== 1) return
      touchStartY = e.touches[0].clientY
      touchActive = true
      accumDy = 0
    }, { passive: true })

    // MUST be non-passive so we can preventDefault and stop page scroll
    container.addEventListener('touchmove', (e) => {
      if (!touchActive || e.touches.length !== 1) return

      // Always prevent default to stop iOS page scroll
      e.preventDefault()

      const dy = touchStartY - e.touches[0].clientY
      touchStartY = e.touches[0].clientY

      // Accumulate sub-line pixel deltas for smooth scrolling
      accumDy += dy
      const cellHeight = (container.clientHeight / (this.term.rows || 24)) || 17
      const lines = Math.trunc(accumDy / cellHeight)
      if (lines !== 0) {
        this.term.scrollLines(lines)
        accumDy -= lines * cellHeight
      }
    }, { passive: false })

    container.addEventListener('touchend', () => {
      touchActive = false
      accumDy = 0
    }, { passive: true })
  }

  _connect() {
    this._exited = false
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    this._ws = new WebSocket(`${proto}//${location.host}${WS_PATH}`)

    this._ws.onopen = () => {
      this._reconnectAttempts = 0 // reset backoff on success
      this.onStatusChange(true)
      const { cols, rows } = this._dimensions()
      this._send({
        type: 'attach',
        projectId: this.projectId,
        sessionType: this.sessionType,
        claudeSessionId: this.claudeSessionId,
        cliProvider: this.cliProvider,
        cols,
        rows,
      })
      this._startPing()
      // Enable local echo for bash sessions only. Claude Code runs a full-screen
      // TUI — the backspace-erase sequences from _clearPredictions() corrupt its
      // cursor-positioned ANSI rendering and break colors.
      if (this.sessionType === 'bash') {
        this.localEcho.enabled = true
      }
    }

    this._ws.onmessage = (e) => {
      let msg
      try {
        msg = JSON.parse(e.data)
      } catch {
        return
      }

      if (msg.type === 'history') {
        if (msg.data) this.term.write(msg.data)
      } else if (msg.type === 'output') {
        const toWrite = this.localEcho.reconcile(msg.data)
        if (toWrite) this.term.write(toWrite)
      } else if (msg.type === 'pong') {
        this._onPong(msg.id)
      } else if (msg.type === 'exit') {
        this._exited = true
        this.term.write(
          '\r\n\x1b[90m[Process exited with code ' +
            (msg.exitCode ?? '?') +
            '. Press Enter to restart]\x1b[0m\r\n'
        )
      } else if (msg.type === 'error') {
        this.term.write('\r\n\x1b[90m[Error: ' + (msg.error || 'unknown') + ']\x1b[0m\r\n')
      }
    }

    this._ws.onclose = () => {
      this._stopPing()
      this.onStatusChange(false)
      if (!this._exited) {
        this._scheduleReconnect()
      }
    }

    this._ws.onerror = () => {
      // onclose fires after this
    }
  }

  /** Auto-reconnect with exponential backoff */
  _scheduleReconnect() {
    const delay = Math.min(BACKOFF_BASE * 2 ** this._reconnectAttempts, BACKOFF_MAX)
    this._reconnectAttempts++
    this.term.write(
      `\r\n\x1b[90m[Connection lost. Reconnecting in ${(delay / 1000).toFixed(1)}s...]\x1b[0m\r\n`
    )
    clearTimeout(this._reconnectTimer)
    this._reconnectTimer = setTimeout(() => {
      if (this._ws) {
        this._ws.onclose = null
        this._ws.close()
      }
      this._connect()
    }, delay)
  }

  /**
   * Send text from the unified input bar with local echo prediction.
   * On high-latency connections, the printable characters appear in the
   * terminal immediately; the LocalEcho reconciler suppresses duplicates
   * when the server echoes them back.
   *
   * @param {string} text — the command text (without trailing \r)
   */
  sendInputWithEcho(text) {
    // Local echo prediction for bash sessions only. Claude Code runs a
    // full-screen TUI — the backspace-erase sequences that _clearPredictions()
    // emits to undo local echo corrupt the TUI layout and break ANSI colors.
    if (this.localEcho.enabled && this.sessionType === 'bash') {
      for (let i = 0; i < text.length; i++) {
        const echo = this.localEcho.predict(text[i])
        if (echo) this.term.write(echo)
      }
    }
    if (this.sessionType === 'claude') {
      // Claude Code's TUI processes raw input. When text + \r arrive as a
      // single chunk, the TUI populates the input but doesn't treat the
      // trailing \r as a distinct Enter keypress. Send them separately so
      // Claude receives the text first, then Enter as its own event.
      this._send({ type: 'input', data: text })
      setTimeout(() => this._send({ type: 'input', data: '\r' }), 50)
    } else {
      // Send full text + Enter to PTY. The \r is intentionally NOT predicted —
      // the server will respond with newline + output, which the reconciler
      // passes through after consuming the matching predicted characters.
      this._send({ type: 'input', data: text + '\r' })
    }
  }

  /**
   * Send raw data to the PTY without local echo (for control sequences,
   * Tab completion requests, Ctrl+C, etc.).
   *
   * @param {string} data — raw bytes to write
   */
  sendRaw(data) {
    this._send({ type: 'input', data })
  }

  /**
   * Switch to another project; reconnects to that project's session (with history).
   * @param {string} projectId
   */
  switchProject(projectId) {
    if (projectId === this.projectId) return
    this.projectId = projectId
    this.claudeSessionId = ''
    clearTimeout(this._reconnectTimer)
    this._stopPing()
    if (this._ws) {
      this._ws.onclose = null
      this._ws.close()
      this._ws = null
    }
    this.term.clear()
    this._connect()
  }

  /**
   * Switch to another claude session ID; reconnects to that session (with history).
   * @param {string} claudeSessionId — UUID for resume, or 'new-N' for fresh
   */
  switchSession(claudeSessionId) {
    if (claudeSessionId === this.claudeSessionId) return
    this.claudeSessionId = claudeSessionId
    this._reconnectNow()
  }

  /**
   * Force reconnect (e.g. after provider change). Tears down current
   * WebSocket and creates a fresh connection using current settings.
   */
  reconnect() {
    this._reconnectNow()
  }

  _reconnectNow() {
    clearTimeout(this._reconnectTimer)
    this._stopPing()
    if (this._ws) {
      this._ws.onclose = null
      this._ws.close()
      this._ws = null
    }
    this.term.clear()
    this._connect()
  }

  _send(msg) {
    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
      this._ws.send(JSON.stringify(msg))
    }
  }

  _startPing() {
    this._stopPing()
    const sendPing = () => {
      this._send({ type: 'ping', id: Date.now() })
    }
    sendPing()
    this._pingInterval = setInterval(sendPing, PING_INTERVAL_MS)
  }

  _stopPing() {
    if (this._pingInterval) {
      clearInterval(this._pingInterval)
      this._pingInterval = null
    }
  }

  _onPong(sentAt) {
    const rtt = Date.now() - sentAt
    if (this._rttEwma === null) {
      this._rttEwma = rtt
    } else {
      this._rttEwma = RTT_EWMA_ALPHA * rtt + (1 - RTT_EWMA_ALPHA) * this._rttEwma
    }
    // Local echo only for bash — Claude Code's TUI is ANSI-positioned and
    // the backspace cleanup from _clearPredictions() corrupts its display.
    if (this.sessionType !== 'bash') return
    if (this._rttEwma > LOCAL_ECHO_ENABLE_RTT_MS) {
      this.localEcho.enabled = true
    } else if (this._rttEwma < LOCAL_ECHO_DISABLE_RTT_MS) {
      this.localEcho.enabled = false
    }
  }

  _dimensions() {
    return {
      cols: this.term.cols || 80,
      rows: this.term.rows || 24,
    }
  }

  _fit() {
    try {
      this.fitAddon.fit()
      if (!this._exited) {
        const { cols, rows } = this._dimensions()
        this._send({ type: 'resize', cols, rows })
      }
    } catch {
      // ignore fit errors during teardown
    }
  }

  dispose() {
    this._stopPing()
    clearTimeout(this._reconnectTimer)
    clearTimeout(this._resizeTimer)
    this._resizeObserver.disconnect()
    this._dataDisposable.dispose()
    this._keyDisposable.dispose()
    if (this._ws) {
      this._ws.onclose = null
      this._ws.close()
    }
    this.term.dispose()
  }
}
