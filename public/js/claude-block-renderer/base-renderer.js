/**
 * BaseBlockRenderer — shared scaffolding for DOM-based chat renderers.
 *
 * Extracts the common pieces every agent-session renderer needs:
 *   - scroll container + scroll-to-bottom floating button
 *   - smart auto-scroll (stick to bottom unless the user scrolled up)
 *   - WebSocket lifecycle (connect / reconnect with backoff / ping)
 *   - thinking-state broadcasting (nanocode:<agent>-thinking events)
 *   - system / user block helpers (reusing the cbr- dom-render components)
 *   - streaming markdown + syntax-highlight helpers (shared with subclasses)
 *
 * Subclasses (ClaudeBlockRenderer, OpenCodeBlockRenderer) provide:
 *   - _handleEvent(event, opts)   — render one structured event
 *   - _fetchAndReplayHistory()    — load persisted history before attach
 *   - WS_EVENT_TYPE               — the `{type: 'xxx-event'}` envelope name
 *   - THINKING_EVENT_NAME         — the nanocode:<agent>-thinking event name
 *
 * The dom-render.js block factories (createSystemBlock, createUserBlock,
 * createTextBlock, …) are reused verbatim so every subclass shares the same
 * visual language and CSS (.cbr-*).
 */

import {
  createSystemBlock,
  createUserBlock,
} from './dom-render.js'

// ── WS constants ──────────────────────────────────────────────────────────────
export const WS_PATH = '/ws/terminal'
export const BACKOFF_BASE = 500
export const BACKOFF_MAX = 10_000
export const PING_INTERVAL_MS = 5000

// ── Shared helpers (re-exported so subclasses can use the same instances) ────

export function escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * Streaming code-block closing-backtick guard.
 *
 * When streaming, marked.parse() on text with an unclosed ``` fence wraps
 * ALL remaining text inside the code block, causing layout chaos. We detect
 * unclosed fences and omit them from the render pass; the next chunk that
 * closes the fence triggers a proper render.
 *
 * Returns { safe: string, truncated: boolean }
 */
export function guardUnclosedFences(text) {
  if (!text) return { safe: text, truncated: false }
  const lines = text.split('\n')
  let fenceOpen = false
  let lastFenceStart = -1
  let charOffset = 0
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (/^```/.test(line)) {
      if (!fenceOpen) {
        fenceOpen = true
        lastFenceStart = charOffset
      } else {
        fenceOpen = false
        lastFenceStart = -1
      }
    }
    charOffset += line.length + 1
  }
  if (fenceOpen && lastFenceStart > 0) {
    return { safe: text.slice(0, lastFenceStart).trimEnd(), truncated: true }
  }
  return { safe: text, truncated: false }
}

/**
 * Render markdown to sanitised HTML. Uses the global marked + DOMPurify loaded
 * in index.html. Opens all links in a new tab. Falls back to a minimal
 * inline-markdown renderer when the libraries are unavailable.
 */
export function renderMarkdown(text, { streaming = false } = {}) {
  if (!text) return ''
  let renderText = text
  if (streaming) {
    const { safe } = guardUnclosedFences(text)
    renderText = safe || text
  }
  try {
    if (window.marked && window.DOMPurify) {
      let html = window.DOMPurify.sanitize(window.marked.parse(renderText))
      html = html.replace(/<a /g, '<a target="_blank" rel="noopener noreferrer" ')
      // Syntax-highlight fenced code blocks via highlight.js. marked emits
      // <pre><code class="language-xxx">…</code></pre>; hljs.highlightElement
      // needs a DOM node, so we parse the HTML, highlight, and re-serialize.
      if (window.hljs && /<code class="language-/.test(html)) {
        try {
          const tpl = document.createElement('template')
          tpl.innerHTML = html
          tpl.content.querySelectorAll('pre code').forEach((codeEl) => {
            // marked puts the lang in class="language-xxx"
            const langMatch = /language-(\S+)/.exec(codeEl.className)
            const lang = langMatch ? langMatch[1] : ''
            try {
              if (lang) {
                codeEl.innerHTML = window.hljs.highlight(codeEl.textContent, { language: lang, ignoreIllegals: true }).value
              } else {
                codeEl.innerHTML = window.hljs.highlightAuto(codeEl.textContent).value
              }
              codeEl.classList.add('hljs')
            } catch {}
          })
          html = tpl.innerHTML
        } catch {}
      }
      return html
    }
  } catch {}
  const lines = renderText.split('\n')
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

/**
 * Syntax-highlight a code string with highlight.js. Returns highlighted HTML
 * (or escaped HTML when hljs is missing / fails).
 */
export function renderCode(code, lang) {
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

/**
 * Wire up Copy buttons inside a rendered block. Idempotent — only attaches to
 * .cbr-copy-btn elements that haven't been bound yet.
 */
export function attachCopyHandlers(el) {
  el.querySelectorAll('.cbr-copy-btn').forEach((btn) => {
    if (btn._cbrCopyBound) return
    btn._cbrCopyBound = true
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

// Path / URL regexes for clickable file paths in text blocks.
const PATH_RE = /(?:(?:\/(?:storage|home)\/[^\s,;:!?()\[\]"'<>]+)|(?:~\/[^\s,;:!?()\[\]"'<>]+)|(?<![:/])(?:[a-zA-Z][a-zA-Z0-9_.-]*(?:\/[a-zA-Z0-9_.+-]+)+\.[a-zA-Z]{2,10})(?=\s|$|[,;:!?()\[\]"'<>]))/g
const URL_RE = /https?:\/\/[^\s"'<>[\]()]+[^\s"'<>[\]().,;:!?]/g

/**
 * Walk text nodes inside `root`, find file paths and bare URLs, and replace
 * them with clickable elements. Skips nodes inside <a>, <pre>, <code>.
 */
export function attachPathAndUrlHandlers(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      let p = node.parentElement
      while (p && p !== root) {
        const tag = p.tagName.toLowerCase()
        if (tag === 'a' || tag === 'pre' || tag === 'code') return NodeFilter.FILTER_REJECT
        p = p.parentElement
      }
      return NodeFilter.FILTER_ACCEPT
    },
  })
  const textNodes = []
  let node
  while ((node = walker.nextNode())) textNodes.push(node)

  for (const textNode of textNodes) {
    const text = textNode.nodeValue
    if (!text) continue
    if (!/https?:\/\//.test(text) && !/(\/storage\/|\/home\/|~\/|\w+\/\w+\.\w{1,10})/.test(text)) continue

    const matches = []
    let m
    URL_RE.lastIndex = 0
    PATH_RE.lastIndex = 0
    while ((m = URL_RE.exec(text)) !== null) {
      matches.push({ type: 'url', start: m.index, end: m.index + m[0].length, value: m[0] })
    }
    URL_RE.lastIndex = 0
    while ((m = PATH_RE.exec(text)) !== null) {
      if (m[0].length > 300) continue
      matches.push({ type: 'path', start: m.index, end: m.index + m[0].length, value: m[0] })
    }
    PATH_RE.lastIndex = 0
    if (!matches.length) continue

    matches.sort((a, b) => a.start - b.start)
    const deduped = []
    let lastEnd = 0
    for (const match of matches) {
      if (match.start < lastEnd) continue
      deduped.push(match)
      lastEnd = match.end
    }
    if (!deduped.length) continue

    const frag = document.createDocumentFragment()
    let pos = 0
    for (const match of deduped) {
      if (match.start > pos) {
        frag.appendChild(document.createTextNode(text.slice(pos, match.start)))
      }
      if (match.type === 'url') {
        const a = document.createElement('a')
        a.href = match.value
        a.target = '_blank'
        a.rel = 'noopener noreferrer'
        a.textContent = match.value
        a.className = 'cbr-autolink-url'
        frag.appendChild(a)
      } else {
        const span = document.createElement('span')
        span.className = 'cbr-path-link'
        span.textContent = match.value
        span.title = 'Open in explorer: ' + match.value
        span.dataset.path = match.value
        span.addEventListener('click', (e) => {
          e.stopPropagation()
          document.dispatchEvent(new CustomEvent('nanocode:open-in-explorer', {
            detail: { path: match.value },
            bubbles: true,
          }))
        })
        frag.appendChild(span)
      }
      pos = match.end
    }
    if (pos < text.length) {
      frag.appendChild(document.createTextNode(text.slice(pos)))
    }
    textNode.parentNode.replaceChild(frag, textNode)
  }
}

// ── Base class ────────────────────────────────────────────────────────────────

export class BaseBlockRenderer {
  /**
   * @param {HTMLElement} container
   * @param {object} opts
   * @param {string} opts.projectId
   * @param {string} opts.tabId
   * @param {function} [opts.onStatusChange]
   * @param {string} opts.containerClass  — CSS class added to container (e.g. 'cbr-container')
   * @param {string} opts.scrollClass      — CSS class for the scroll area (e.g. 'cbr-scroll')
   * @param {string} opts.thinkingEventName — CustomEvent name for thinking state (e.g. 'nanocode:claude-thinking')
   */
  constructor(container, opts = {}) {
    this.container = container
    this.projectId = opts.projectId
    this.tabId = opts.tabId
    this.onStatusChange = opts.onStatusChange || (() => {})

    // Subclass configuration (overridable)
    this._containerClass = opts.containerClass || 'cbr-container'
    this._scrollClass = opts.scrollClass || 'cbr-scroll'
    this._thinkingEventName = opts.thinkingEventName || 'nanocode:agent-thinking'

    // TerminalPane-compatible stub (tab-manager calls pane.fitAddon.fit())
    this.fitAddon = { fit: () => {} }

    // containerClass / scrollClass may be a space-separated list of classes;
    // split so classlist.add receives individual tokens.
    for (const cls of (this._containerClass || '').split(/\s+/).filter(Boolean)) {
      container.classList.add(cls)
    }
    this._scroll = document.createElement('div')
    for (const cls of (this._scrollClass || '').split(/\s+/).filter(Boolean)) {
      this._scroll.classList.add(cls)
    }
    container.appendChild(this._scroll)

    // Scroll-to-bottom button
    this._scrollBtn = document.createElement('button')
    this._scrollBtn.className = 'cbr-scroll-to-bottom'
    this._scrollBtn.setAttribute('aria-label', 'Scroll to bottom')
    this._scrollBtn.title = 'Scroll to bottom'
    this._scrollBtn.innerHTML =
      `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">` +
      `<polyline points="6 9 12 15 18 9"/></svg>`
    this._scrollBtn.addEventListener('click', () => {
      this._userScrolledUp = false
      this._scroll.scrollTo({ top: this._scroll.scrollHeight, behavior: 'smooth' })
    })
    container.appendChild(this._scrollBtn)

    // Smart auto-scroll: true when the user has scrolled away from the bottom
    this._userScrolledUp = false
    let _scrollRafPending = false
    this._scroll.addEventListener('scroll', () => {
      if (_scrollRafPending) return
      _scrollRafPending = true
      requestAnimationFrame(() => {
        _scrollRafPending = false
        this._userScrolledUp = !this._isAtBottom()
        this._updateScrollBtn()
      })
    }, { passive: true })

    // WS state
    this._ws = null
    this._exited = false
    this._reconnectAttempts = 0
    this._reconnectTimer = null
    this._pingInterval = null

    // Thinking state
    this._thinking = false

    // Replay mode flag (suppress per-block rAF scrolls during bulk replay)
    this._replayMode = false
  }

  // ── Scroll helpers ──────────────────────────────────────────────────────────

  _isAtBottom(threshold = 60) {
    const s = this._scroll
    return s.scrollHeight - s.scrollTop - s.clientHeight < threshold
  }

  _updateScrollBtn() {
    this._scrollBtn.classList.toggle('cbr-scroll-btn-visible', !this._isAtBottom())
  }

  _scrollBottom({ force = false } = {}) {
    if (this._replayMode) return
    if (!force && this._userScrolledUp) return
    requestAnimationFrame(() => {
      this._scroll.scrollTop = this._scroll.scrollHeight
      this._updateScrollBtn()
    })
  }

  /**
   * Called by the tab manager when this pane becomes the active/visible tab.
   * Re-pin to the bottom in case history replayed while the tab was hidden.
   */
  onActivated() {
    requestAnimationFrame(() => {
      this._scroll.scrollTop = this._scroll.scrollHeight
      this._updateScrollBtn()
    })
  }

  // ── Thinking state ──────────────────────────────────────────────────────────

  isThinking() {
    return this._thinking
  }

  _setThinking(val) {
    if (this._thinking === val) return
    this._thinking = val
    document.dispatchEvent(new CustomEvent(this._thinkingEventName, {
      detail: { tabId: this.tabId, thinking: val },
    }))
  }

  // ── Block helpers (reusing dom-render.js factories) ─────────────────────────

  _addSystemBlock(msg) {
    const article = createSystemBlock(msg, { escHtml })
    this._scroll.appendChild(article)
    this._scrollBottom()
    return article
  }

  _appendUserBlock(text) {
    const article = createUserBlock(text, { escHtml, attachPathAndUrlHandlers })
    this._scroll.appendChild(article)
    this._scrollBottom()
  }

  // ── WS connection ───────────────────────────────────────────────────────────
  //
  // Subclass contract:
  //   - _onWsOpen(isReconnect)        — set up replay + send attach
  //   - _onWsMessage(msg)             — handle a parsed WS message
  //   - WS_EVENT_TYPE                  — the envelope `{type}` for structured events
  //
  // The base class manages connect/backoff/ping and dispatches the common
  // envelope types (pong / exit / error). Structured events are handed to
  // _onWsMessage for subclass-specific rendering.

  _connect() {
    this._exited = false
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    this._ws = new WebSocket(`${proto}//${location.host}${WS_PATH}`)

    this._ws.onopen = () => {
      const isReconnect = this._reconnectAttempts > 0
      this._reconnectAttempts = 0
      this.onStatusChange(true)
      if (typeof this._onWsOpen === 'function') {
        this._onWsOpen(isReconnect)
      } else {
        // Default: send a plain attach. Subclasses typically override _onWsOpen
        // to fetch history first, then send attach.
        this._send({
          type: 'attach',
          projectId: this.projectId,
          sessionType: 'bash',
          tabId: this.tabId,
          cols: 200,
          rows: 50,
        })
      }
      this._startPing()
    }

    this._ws.onmessage = (e) => {
      let msg
      try { msg = JSON.parse(e.data) } catch { return }
      if (msg.type === 'pong') return
      if (msg.type === 'exit') {
        this._exited = true
        this._setThinking(false)
        this._onWsExit?.(msg)
        this._addSystemBlock(`[Session ended (exit ${msg.exitCode ?? '?'}). Send a message to start a new session.]`)
        return
      }
      if (msg.type === 'error') {
        this._addSystemBlock('[Error: ' + (msg.error || 'unknown') + ']')
        return
      }
      // Hand off to subclass for everything else (structured events, history, etc.)
      if (typeof this._onWsMessage === 'function') {
        this._onWsMessage(msg)
      }
    }

    this._ws.onclose = () => {
      this._stopPing()
      this.onStatusChange(false)
      if (!this._exited) {
        const delay = Math.min(BACKOFF_BASE * 2 ** this._reconnectAttempts, BACKOFF_MAX)
        this._reconnectAttempts++
        this._onWsDisconnect?.(delay)
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

  dispose() {
    clearTimeout(this._reconnectTimer)
    this._stopPing()
    if (typeof this._onDispose === 'function') this._onDispose()
    if (this._ws) {
      this._ws.onclose = null
      this._ws.close()
      this._ws = null
    }
  }
}
