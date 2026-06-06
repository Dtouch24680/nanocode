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

// ── Lazy history loading ───────────────────────────────────────────────────────
// Initial replay: only render the last N events to keep DOM lean.
// "Load more" prepends another HISTORY_PAGE events when user scrolls to top.
// Raised from 50 → 200 to reduce the "records disappeared" perception when
// the user returns to nanocode after switching tabs (bfcache miss / page reload).
const INITIAL_HISTORY_BLOCKS = 200
const HISTORY_PAGE_SIZE = 50

// ── P2-1: Tool icon map (inline 16×16 SVG, no external deps) ─────────────────
const TOOL_ICONS = {
  // Terminal / shell
  Bash:        `<svg class="cbr-tool-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="18" rx="2"/><polyline points="8 10 12 14 16 10"/><line x1="8" y1="14" x2="16" y2="14"/></svg>`,
  // File reading
  Read:        `<svg class="cbr-tool-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>`,
  // File editing / writing (pencil)
  Edit:        `<svg class="cbr-tool-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>`,
  Write:       `<svg class="cbr-tool-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>`,
  MultiEdit:   `<svg class="cbr-tool-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>`,
  // Search / magnifier
  WebSearch:   `<svg class="cbr-tool-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>`,
  WebFetch:    `<svg class="cbr-tool-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>`,
  // Grep / funnel filter
  Grep:        `<svg class="cbr-tool-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/></svg>`,
  // Glob / wildcard (asterisk)
  Glob:        `<svg class="cbr-tool-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="2" x2="12" y2="22"/><line x1="2" y1="12" x2="22" y2="12"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/><line x1="19.07" y1="4.93" x2="4.93" y2="19.07"/></svg>`,
  LS:          `<svg class="cbr-tool-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>`,
  // Todo / checklist
  TodoWrite:   `<svg class="cbr-tool-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>`,
  TodoRead:    `<svg class="cbr-tool-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>`,
  // Agent / robot (subagent dispatch)
  Task:        `<svg class="cbr-tool-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="10" rx="2"/><circle cx="12" cy="5" r="2"/><path d="M12 7v4"/><line x1="8" y1="16" x2="8" y2="16"/><line x1="12" y1="16" x2="12" y2="16"/><line x1="16" y1="16" x2="16" y2="16"/></svg>`,
  Agent:       `<svg class="cbr-tool-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="10" rx="2"/><circle cx="12" cy="5" r="2"/><path d="M12 7v4"/><line x1="8" y1="16" x2="8" y2="16"/><line x1="12" y1="16" x2="12" y2="16"/><line x1="16" y1="16" x2="16" y2="16"/></svg>`,
  TaskCreate:  `<svg class="cbr-tool-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="10" rx="2"/><circle cx="12" cy="5" r="2"/><path d="M12 7v4"/><line x1="8" y1="16" x2="8" y2="16"/><line x1="12" y1="16" x2="12" y2="16"/><line x1="16" y1="16" x2="16" y2="16"/></svg>`,
  // Notebook
  NotebookRead:  `<svg class="cbr-tool-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>`,
  NotebookEdit:  `<svg class="cbr-tool-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>`,
}

function getToolIcon(toolName) {
  if (!toolName) return ''
  return TOOL_ICONS[toolName] || ''
}

// ── Tool-block fold level ──────────────────────────────────────────────────────
// Three levels (persisted in localStorage):
//   'full'    — show tool name + full input/output content
//   'header'  — show only the tool name header (block state)
//   'line'    — collapse to a single thin line (default, Q4 answer C)
//
// Cycle order (Q2 answer A): full → header → line → full → …
// Default is 'line' (most screen-efficient, user-requested).
const TOOL_FOLD_KEY = 'cbr_tool_fold'
const TOOL_FOLD_LEVELS = ['full', 'header', 'line']

// 3-state cycle map: full → header → line → full
const TOOL_FOLD_CYCLE = { full: 'header', header: 'line', line: 'full' }

function getToolFoldLevel() {
  const v = localStorage.getItem(TOOL_FOLD_KEY)
  // Default: 'line' (Q4 answer C — most screen-efficient)
  return TOOL_FOLD_LEVELS.includes(v) ? v : 'line'
}

/**
 * Cycle a tool block's data-fold attribute through the 3 states.
 * full → header → line → full → …  (Q2 answer A)
 * Works for both .cbr-block-tool and .cbr-block-tool-result articles.
 */
function cycleToolFold(article) {
  const cur = article.getAttribute('data-fold') || getToolFoldLevel()
  const next = TOOL_FOLD_CYCLE[cur] || 'full'
  article.setAttribute('data-fold', next)
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

// N16 fix: strip Claude's internal XML system-caveat tags before rendering.
// These tags (e.g. <local-command-caveat>, <function_calls>) are implementation
// details that must never be shown raw to the user. We strip the full tag block
// including its content; stripping only tags while keeping content makes the
// text even more confusing.
const XML_CAVEAT_TAGS = [
  'local-command-caveat',
  'antml:function_calls',
  'function_calls',
  'antml:invoke',
  'antml:parameter',
  'command-caveat',
]
function stripXmlCaveats(text) {
  if (!text || !/</.test(text)) return text
  let out = text
  for (const tag of XML_CAVEAT_TAGS) {
    // Strip complete <tag ...>...</tag> blocks (including content)
    out = out.replace(new RegExp(`<${tag}(?:\\s[^>]*)?>.*?<\\/${tag}>`, 'gsi'), '')
    // Strip self-closing <tag ... />
    out = out.replace(new RegExp(`<${tag}(?:\\s[^>]*)?\\/?>`, 'gi'), '')
  }
  return out.trim()
}

function renderMarkdown(text) {
  if (!text) return ''
  text = stripXmlCaveats(text)
  if (!text) return ''
  try {
    if (window.marked && window.DOMPurify) {
      let html = window.DOMPurify.sanitize(window.marked.parse(text))
      // Open all markdown-rendered links in a new tab. Without this, clicking a
      // link (e.g. a viewer URL in an assistant response) navigates the nanocode
      // page away in the same tab — reloading the app and losing in-flight messages
      // that haven't been flushed to the session jsonl yet.
      // attachPathAndUrlHandlers() already handles bare-URL text nodes, but it
      // explicitly skips nodes inside existing <a> elements, so marked-rendered
      // links would be missed without this post-processing step.
      html = html.replace(/<a /g, '<a target="_blank" rel="noopener noreferrer" ')
      return html
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

// ── Feature 2: Clickable file paths ──────────────────────────────────────────
//
// Conservative regex: matches absolute /storage/... or ~/... paths, or
// relative repo paths like "server/index.js" (must have at least one "/" and
// end with a known extension or be a file-like segment with no spaces).
//
// Rules to avoid false positives:
//   - Must start with / or ~/ or contain an interior "/" (not just bare words)
//   - Absolute paths must start with /storage/ or /home/ or ~/
//   - Relative paths must contain at least one "/" and end with a word char or known ext
//   - Must NOT be wrapped in an existing <a> (handled by DOM walk below)
//   - Max length guard: skip if segment > 300 chars
//
// This regex is intentionally NOT applied to markdown-rendered HTML (which
// marked already handles links). It is applied to raw text nodes only.

// Path regex rules:
//   - Absolute: must start with /storage/, /home/, or ~/
//     Matches word chars, dots, hyphens, slashes — no spaces — excluding trailing punctuation
//   - Relative: identifier/path/file.ext — NO spaces, at least one slash,
//     must end with a known-ish extension (2-10 chars alpha), NOT preceded by :// (avoid
//     matching inside URLs twice), and NOT pure numbers/dots (version fractions)
// Trailing punctuation (.,;:!) is excluded via negative lookahead.
const PATH_RE = /(?:(?:\/(?:storage|home)\/[^\s,;:!?()\[\]"'<>]+)|(?:~\/[^\s,;:!?()\[\]"'<>]+)|(?<![:/])(?:[a-zA-Z][a-zA-Z0-9_.-]*(?:\/[a-zA-Z0-9_.+-]+)+\.[a-zA-Z]{2,10})(?=\s|$|[,;:!?()\[\]"'<>]))/g

// URL regex: bare http(s):// links not already inside an <a>
const URL_RE = /https?:\/\/[^\s"'<>[\]()]+[^\s"'<>[\]().,;:!?]/g

/**
 * Walk text nodes inside `root`, find file paths and bare URLs, and replace
 * them with clickable elements. Skips nodes already inside <a>, <pre>, <code>.
 */
function attachPathAndUrlHandlers(root) {
  // Collect text nodes that are not inside <a>, <pre>, or <code>
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

    // Quick pre-check: does this text contain anything interesting?
    if (!/https?:\/\//.test(text) && !/(\/storage\/|\/home\/|~\/|\w+\/\w+\.\w{1,10})/.test(text)) continue

    // Build a combined regex pass: find all URLs and paths
    // Strategy: find all matches with their positions, sort by index,
    // split the text into literal + clickable parts.
    const matches = []
    let m

    // Reset lastIndex
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

    // Sort by start position, then remove overlaps
    matches.sort((a, b) => a.start - b.start)
    const deduped = []
    let lastEnd = 0
    for (const match of matches) {
      if (match.start < lastEnd) continue  // overlaps previous match — skip
      deduped.push(match)
      lastEnd = match.end
    }

    if (!deduped.length) continue

    // Build a document fragment replacing matched spans with elements
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

    // Track the "Connection lost" system block for in-place update (N34 dedup)
    this._connLostEl = null

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

    // Count-based text dedup for user events:
    // cs.history userEvent uuid (randomUUID, generated by routes.js) ≠ jsonl user uuid
    // (assigned by claude CLI), so uuid-based dedup alone can't prevent double-render.
    // Track each user message text with a count of how many times it appears in the
    // jsonl. On cs.history replay, decrement and skip if count > 0.
    // Map<text, count> — handles repeated identical messages correctly.
    this._replayedUserTexts = new Map()

    // ── Lazy history state ──────────────────────────────────────────────────────
    // Full fetched event array from the server (never discarded).
    // _historyRenderedStart is the index into this array of the earliest event
    // that has been rendered. Rendering always proceeds from [_historyRenderedStart]
    // upward. Events below that index are "older" and will be prepended on scroll.
    this._historyEvents = []       // all events fetched from server
    this._historyRenderedStart = 0 // index of oldest rendered event in _historyEvents
    this._historyLoadingSentinel = null  // <div> at top, watched by IntersectionObserver
    this._historyObserver = null   // IntersectionObserver for the sentinel
    this._historyLoading = false   // prevent concurrent load-more

    // Thinking state: true when claude is processing a turn
    this._thinking = false

    // Replay mode flag: true while _fetchAndReplayHistory is running.
    // Used to suppress per-block rAF scrolls and TTS dispatches during bulk replay.
    this._replayMode = false

    // Streaming render throttle: rAF handle for pending live-block markdown update.
    // Prevents running marked.parse() on every WS chunk (can be 10s/sec).
    this._streamRafPending = false

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
    // Ctrl+C: POST interrupt API (real interrupt, not a no-op).
    // This is called by the touch toolbar ctrl-c button and legacy callers.
    if (data === '\x03') {
      this.showInterruptBlock()
      if (this.projectId && this.tabId) {
        fetch(`/api/projects/${this.projectId}/tabs/${this.tabId}/interrupt`, { method: 'POST' })
          .catch(() => {})
      }
    }
    // Ctrl+L: visually clear the scroll area
    if (data === '\x0c') {
      this._scroll.innerHTML = ''
    }
  }

  /**
   * N19 fix: Clear DOM + history state after a session reset so old queued
   * events cannot replay into the new session's view. Called by the reset
   * button handler in terminal-view.js after the POST /reset succeeds.
   */
  clearAfterReset() {
    // Stop lazy-history observer
    this._removeHistorySentinel()
    this._historyEvents = []
    this._historyRenderedStart = 0
    this._historyLoading = false

    // Clear visible DOM
    this._scroll.innerHTML = ''
    this._liveAssistantBlock = null
    this._liveAssistantId = null
    this._liveSubagentBlock = null
    if (this._liveToolBlocks) this._liveToolBlocks.clear()

    // Reset dedup sets so new session events are not silently skipped
    this._replayedUuids = new Set()
    this._replayedUserTexts = new Map()
    this._seenSubagentUuids = new Set()
    this._pendingNonces = new Set()

    // Exit thinking state
    this._thinking = false
    document.dispatchEvent(new CustomEvent('nanocode:claude-thinking', {
      detail: { tabId: this.tabId, thinking: false },
    }))

    this._addSystemBlock('[Session reset. Starting fresh.]')
  }

  /**
   * Insert a CLI-style interrupted block into the conversation flow.
   * Called by doInterrupt() (Esc / Stop btn) and sendRaw('\x03') (Ctrl+C / touch toolbar).
   * Text matches the Claude CLI: "[Request interrupted by user]".
   */
  showInterruptBlock() {
    const article = this._makeBlock('cbr-block-system cbr-block-interrupted')
    article.innerHTML = `<p class="cbr-system cbr-interrupted">[Request interrupted by user]</p>`
    this._scroll.appendChild(article)
    this._scrollBottom()
  }

  dispose() {
    clearTimeout(this._reconnectTimer)
    this._stopPing()
    this._removeHistorySentinel()
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
   * Lazy loading strategy (front-end batching):
   *   - All events are fetched from the server at once (no backend pagination).
   *   - Only the last INITIAL_HISTORY_BLOCKS events are rendered into the DOM.
   *   - A sentinel <div> is inserted at the top; an IntersectionObserver watches
   *     it and prepends another HISTORY_PAGE_SIZE batch when the user scrolls up.
   *   - Scroll position is preserved via scrollHeight-delta compensation so the
   *     view doesn't jump when older content is prepended.
   *
   * De-dup strategy: ALL fetched events' uuids are recorded in _replayedUuids
   * (even those not yet rendered). When the WS subsequently replays cs.history
   * the dedup guard will skip already-seen events regardless of render status.
   * When "load more" renders older events they are NOT re-added to _replayedUuids
   * (they're already there), so no issues arise.
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

    // Register ALL uuids for dedup (even those we won't render immediately).
    // This is important: WS cs.history replay must skip ALL of these events,
    // not just the ones we rendered. Otherwise older-but-not-yet-rendered events
    // would be rendered again when a WS reconnect replays cs.history.
    this._replayedUserTexts = new Map()  // reset on each fetch
    for (const event of events) {
      if (event.uuid) this._replayedUuids.add(event.uuid)
      // Count-based user-text dedup: cs.history uuid ≠ jsonl uuid, so uuid dedup
      // alone can't prevent double-render of user messages. Track each text with
      // its occurrence count so that cs.history replays are skipped exactly N times
      // (once per occurrence already rendered from jsonl). Handles duplicate texts.
      if (event.type === 'user') {
        const text = event.message?.content
          ?.filter?.((c) => c?.type === 'text')
          ?.map?.((c) => c.text ?? '')
          .join('') ?? ''
        if (text) this._replayedUserTexts.set(text, (this._replayedUserTexts.get(text) ?? 0) + 1)
      }
    }

    // Store the full event list. Rendering will happen in slices.
    this._historyEvents = events

    // ── Determine which slice to render initially ────────────────────────────
    // We render the last INITIAL_HISTORY_BLOCKS events (most recent), so the
    // user lands at the bottom seeing the newest messages. Everything before
    // that index is available for "load more" when scrolling up.
    const totalEvents = events.length
    const initialStart = Math.max(0, totalEvents - INITIAL_HISTORY_BLOCKS)
    this._historyRenderedStart = initialStart

    const hasOlderHistory = initialStart > 0

    // Show a subtle separator. If we truncated, note how many older events exist.
    if (hasOlderHistory) {
      this._addSystemBlock(
        `[Showing last ${totalEvents - initialStart} of ${totalEvents} event(s). Scroll up to load more.]`
      )
    } else {
      this._addSystemBlock(`[Restored ${totalEvents} event(s) from session history]`)
    }

    // Insert the top-sentinel BEFORE rendering initial blocks (so it sits at top).
    if (hasOlderHistory) {
      this._insertHistorySentinel()
    }

    // ── Render the initial slice in batch replay mode ────────────────────────
    // Suppress per-block _scrollBottom() rAF callbacks and TTS dispatches;
    // do a single scroll-to-bottom at the end.
    this._replayMode = true
    try {
      for (let i = initialStart; i < totalEvents; i++) {
        this._handleEvent(events[i], { fromReplay: true })
      }
    } finally {
      this._replayMode = false
    }

    // Single scroll-to-bottom after all initial blocks are in DOM
    requestAnimationFrame(() => {
      this._scroll.scrollTop = this._scroll.scrollHeight
      this._updateScrollBtn()
    })
  }

  /**
   * Insert a sentinel element at the very top of the scroll area and wire up
   * an IntersectionObserver to trigger loading more history when the sentinel
   * becomes visible (i.e. the user scrolled up to the top).
   */
  _insertHistorySentinel() {
    if (this._historyLoadingSentinel) return  // already installed

    const sentinel = document.createElement('div')
    sentinel.className = 'cbr-history-sentinel'
    sentinel.setAttribute('aria-hidden', 'true')
    // Minimal visual indicator: a thin loading stripe that disappears once all
    // history is loaded. Height=1px ensures IntersectionObserver fires reliably.
    sentinel.style.cssText = 'height:32px;display:flex;align-items:center;justify-content:center;color:var(--text-muted,#888);font-size:12px;opacity:0.6;'
    sentinel.textContent = '↑ scroll up to load older messages'
    this._historyLoadingSentinel = sentinel

    // Prepend: must be the very first child so it's at the top visually
    if (this._scroll.firstChild) {
      this._scroll.insertBefore(sentinel, this._scroll.firstChild)
    } else {
      this._scroll.appendChild(sentinel)
    }

    // IntersectionObserver: fires when sentinel enters the viewport.
    // threshold:0 = fires as soon as even 1px is visible.
    // We use rootMargin:0px so it only fires when truly in view.
    this._historyObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            this._loadMoreHistory()
          }
        }
      },
      { root: this._scroll, threshold: 0, rootMargin: '0px' }
    )
    this._historyObserver.observe(sentinel)
  }

  /**
   * Prepend the next batch of older history events into the DOM.
   * Preserves scroll position by compensating for the added scrollHeight.
   * Called by the IntersectionObserver when the sentinel scrolls into view.
   */
  _loadMoreHistory() {
    if (this._historyLoading) return
    if (this._historyRenderedStart <= 0) {
      // Nothing more to load — remove sentinel and observer
      this._removeHistorySentinel()
      return
    }

    this._historyLoading = true

    // Determine the slice to prepend
    const endIdx = this._historyRenderedStart
    const startIdx = Math.max(0, endIdx - HISTORY_PAGE_SIZE)
    this._historyRenderedStart = startIdx

    // Capture current scroll offset for position compensation
    const scrollEl = this._scroll
    const scrollHeightBefore = scrollEl.scrollHeight
    const scrollTopBefore = scrollEl.scrollTop

    // Render older events into a DocumentFragment (off-DOM for perf)
    const frag = document.createDocumentFragment()

    // We need to insert a temporary container to collect new articles,
    // then prepend them all at once. We render into a detached container.
    const tempContainer = document.createElement('div')

    // Temporarily redirect this._scroll to the temp container so all
    // _render* and _add* methods append there. Restore afterward.
    const realScroll = this._scroll
    this._scroll = tempContainer

    this._replayMode = true
    try {
      for (let i = startIdx; i < endIdx; i++) {
        this._handleEvent(this._historyEvents[i], { fromReplay: true })
      }
    } finally {
      this._replayMode = false
      this._scroll = realScroll
    }

    // Move all newly-rendered children from tempContainer into a fragment
    while (tempContainer.firstChild) {
      frag.appendChild(tempContainer.firstChild)
    }

    // Find insertion point: just after the sentinel (index 1 if sentinel is [0])
    const sentinel = this._historyLoadingSentinel
    const insertAfter = sentinel || null

    if (insertAfter && insertAfter.parentNode === scrollEl) {
      // Insert the batch right after the sentinel
      insertAfter.insertAdjacentElement ? null : null  // (not used; manual DOM splice)
      const nextSibling = insertAfter.nextSibling
      if (nextSibling) {
        scrollEl.insertBefore(frag, nextSibling)
      } else {
        scrollEl.appendChild(frag)
      }
    } else {
      // Fallback: prepend to the very top
      if (scrollEl.firstChild) {
        scrollEl.insertBefore(frag, scrollEl.firstChild)
      } else {
        scrollEl.appendChild(frag)
      }
    }

    // ── Scroll position compensation ─────────────────────────────────────────
    // Adding content at the top shifts all existing content down by the newly
    // added height. Compensate by adding the same delta to scrollTop so the
    // viewport appears unchanged (the user's current view stays in place).
    const scrollHeightAfter = scrollEl.scrollHeight
    const addedHeight = scrollHeightAfter - scrollHeightBefore
    scrollEl.scrollTop = scrollTopBefore + addedHeight

    this._historyLoading = false

    // If we just rendered all remaining history, remove the sentinel
    if (startIdx <= 0) {
      this._removeHistorySentinel()
    }
  }

  /**
   * Remove the top sentinel and disconnect the IntersectionObserver.
   * Called when all history has been loaded.
   */
  _removeHistorySentinel() {
    if (this._historyObserver) {
      this._historyObserver.disconnect()
      this._historyObserver = null
    }
    if (this._historyLoadingSentinel) {
      if (this._historyLoadingSentinel.parentNode) {
        this._historyLoadingSentinel.parentNode.removeChild(this._historyLoadingSentinel)
      }
      this._historyLoadingSentinel = null
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

      // On both first connect and reconnect: reset render state and fetch
      // history from disk (jsonl). This ensures:
      //   - Page reloads / bfcache misses restore FULL history from disk, not
      //     just the in-memory ring buffer (≤500 events). Root cause of
      //     "records disappeared after switching tabs to view GLB".
      //   - WS reconnects also get a fresh jsonl replay so long sessions whose
      //     cs.history ring buffer rolled over don't lose older messages.
      //
      // De-dup: _replayedUuids is reset below so the fresh jsonl replay is not
      // blocked by the previous session's dedup set. WS cs.history events that
      // arrive AFTER the attach are deduplicated against the new set.
      if (isReconnect) {
        // Clean up lazy loading state before clearing the DOM
        this._removeHistorySentinel()
        this._historyEvents = []
        this._historyRenderedStart = 0
        this._historyLoading = false

        this._scroll.innerHTML = ''
        this._liveAssistantBlock = null
        this._liveAssistantId = null
        this._liveSubagentBlock = null
        this._seenSubagentUuids = new Set()
        this._pendingNonces = new Set()
        // Reset dedup sets so fresh jsonl events are not silently skipped.
        this._replayedUuids = new Set()
        this._replayedUserTexts = new Map()
        this._thinking = false
        // Clear the "Connection lost" dedup block on successful reconnect (N34)
        this._connLostEl = null
        this._addSystemBlock('[Reconnected. Restoring session history…]')
      }
      // Both first-connect and reconnect: fetch full jsonl history from disk.
      // On reconnect this supersedes the old cs.history-only path, giving
      // complete history regardless of how long the session has been running.
      //
      // IMPORTANT: send the attach message AFTER _fetchAndReplayHistory resolves.
      // The server replays cs.history immediately upon attach; if we sent attach
      // first, those WS events would race with the jsonl fetch and arrive before
      // _replayedUuids is populated — causing double-render of all events that
      // exist in both cs.history and the jsonl. Awaiting the fetch first ensures
      // _replayedUuids is already filled so WS duplicates are deduped correctly.
      this._fetchAndReplayHistory().finally(() => {
        // Always send attach — even if jsonl fetch failed (404, network error).
        // Without attach the session never starts and the tab hangs blank.
        this._send({
          type: 'attach',
          projectId: this.projectId,
          sessionType: 'bash',
          tabId: this.tabId,
          cols: 200,
          rows: 50,
        })
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
        // N13 fix: clear thinking state on session exit so the client input bar
        // unlocks and any client-side _pendingQueue can flush to the new session.
        this._setThinking(false)
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
        // N34: update the same "Connection lost" block in-place instead of appending new ones
        const msg = `[Connection lost. Reconnecting in ${(delay / 1000).toFixed(1)}s…]`
        if (this._connLostEl) {
          // Update existing block in-place
          const p = this._connLostEl.querySelector('p.cbr-system')
          if (p) p.textContent = msg
        } else {
          this._connLostEl = this._addSystemBlock(msg)
        }
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
    // N1 fix: warn when a user message is dropped due to disconnected WS
    if (msg.type === 'claude-input') {
      this._addSystemBlock('[Connection not ready — message may not have been sent. Please wait for reconnection.]')
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
        this._handleUserEvent(event, opts)
        break
      default:
        // Unknown event: ignore silently
        break
    }

    // Dispatch for TTS and other listeners (skip during replay — history events
    // should not trigger TTS playback or other real-time side-effects)
    if (!this._replayMode) {
      document.dispatchEvent(new CustomEvent('nanocode:terminal-output', {
        detail: JSON.stringify(event),
      }))
    }
  }

  _handleUserEvent(event, opts = {}) {
    // Dedup: if we sent this turn ourselves, a nonce will be in _pendingNonces.
    // Consume and skip so we don't double-render the locally echoed block.
    const nonce = event._nonce
    if (nonce && this._pendingNonces && this._pendingNonces.has(nonce)) {
      this._pendingNonces.delete(nonce)
      return
    }

    // Count-based text dedup: cs.history userEvent uuid ≠ jsonl uuid so the outer
    // _replayedUuids guard can't prevent double-render of user turns. Instead we
    // track how many times each text appears in the jsonl. For each cs.history
    // replay, decrement and skip if count > 0 (the jsonl replay already rendered it).
    // opts.fromReplay=true means this IS the jsonl replay → skip the check.
    if (!opts.fromReplay && this._replayedUserTexts && this._replayedUserTexts.size > 0) {
      const text = event.message?.content
        ?.filter?.((c) => c?.type === 'text')
        ?.map?.((c) => c.text ?? '')
        .join('') ?? ''
      if (text) {
        const remaining = this._replayedUserTexts.get(text) ?? 0
        if (remaining > 0) {
          this._replayedUserTexts.set(text, remaining - 1)
          return  // already rendered from jsonl
        }
      }
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
      // P1-2: show model, plugin count, fast_mode_state in addition to basic session info
      const model = event.model ? ` · ${escHtml(event.model)}` : ''
      const pluginCount = Array.isArray(event.plugins) && event.plugins.length > 0
        ? ` · ${event.plugins.length} plugin${event.plugins.length !== 1 ? 's' : ''}`
        : ''
      const fastMode = event.fast_mode_state != null ? ` · fast:${escHtml(String(event.fast_mode_state))}` : ''
      this._addSystemBlock(`[Session ${sessionId} · ${toolCount} tools available${model}${pluginCount}${fastMode}]`)
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
    } else if (event.subtype === 'resume-trigger') {
      // Server intercepted /resume and resolved the target session.
      // Show feedback then dispatch the same event that Recent Agents uses.
      const label = event.projectName
        ? `Resuming session in ${event.projectName}…`
        : 'Resuming previous session…'
      this._addSystemBlock(`[${label}]`)
      document.dispatchEvent(new CustomEvent('nanocode:resume-session', {
        detail: { projectId: event.projectId, sessionId: event.sessionId, cwd: event.cwd },
      }))
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

    // N47/N52 fix: remove the live assistant block from DOM (not just null the
    // reference). Previously, only the JS reference was cleared; the live DOM
    // element stayed, causing either:
    //   • Duplicate text1 (live partial + final rendered text)
    //   • Ghost empty block with cbr-live border when partial was empty
    //   • text1 appearing BEFORE the tool placeholder if partial streamed ahead
    // Now we physically remove it so the final _renderContentPart calls produce
    // a clean, ordered DOM with no stale fragments.
    if (this._liveAssistantBlock && this._liveAssistantBlock.parentNode) {
      this._liveAssistantBlock.parentNode.removeChild(this._liveAssistantBlock)
    }
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

    // N52 fix: live-update the text part of a partial message even when there
    // are additional non-text parts (e.g. tool_use being streamed alongside
    // commentary text). Previously the condition required EXACTLY one text part
    // with no other parts; any mixed content was silently skipped, leaving text1
    // invisible during streaming (showing only after the final assistant event).
    // Now: extract the FIRST text part from any partial (regardless of other
    // parts in the same message) and keep the live text block updated.
    const firstTextPart = parts.find((p) => p.type === 'text')
    if (firstTextPart) {
      const text = firstTextPart.text || ''
      if (!this._liveAssistantBlock) {
        const article = this._makeBlock('cbr-block-text cbr-live')
        this._scroll.appendChild(article)
        this._liveAssistantBlock = article
        this._scrollBottom()
      }
      // Perf: throttle markdown re-render to one rAF per frame instead of
      // running marked.parse() + innerHTML on every incoming WS chunk.
      // Store the latest text; the pending rAF will pick it up when it fires.
      this._streamPendingText = text
      if (!this._streamRafPending) {
        this._streamRafPending = true
        requestAnimationFrame(() => {
          this._streamRafPending = false
          const latestText = this._streamPendingText
          if (!latestText || !this._liveAssistantBlock) return
          // P1-5: skip frozen blocks — they are finalized and don't need re-render
          if (this._liveAssistantBlock.dataset.frozen === '1') return
          let html
          try { html = renderMarkdown(latestText) } catch { html = `<p>${escHtml(latestText)}</p>` }
          this._liveAssistantBlock.innerHTML = `<div class="cbr-text">${html}</div>`
          // Scroll only if user is near bottom (avoid fighting manual scroll)
          const s = this._scroll
          if (s.scrollHeight - s.scrollTop - s.clientHeight < 120) {
            s.scrollTop = s.scrollHeight
          }
          this._updateScrollBtn()
        })
      }
    }
  }

  _handleResult(event) {
    // End-of-turn: flush live blocks, exit thinking state.
    // N47/N52 fix: also physically remove the live assistant block from DOM
    // (see parallel fix in _handleAssistant). When claude --print sends an
    // error result without a preceding assistant event, the live block might
    // still be in DOM. Remove it here so no stale cbr-live element lingers.
    if (this._liveAssistantBlock && this._liveAssistantBlock.parentNode) {
      this._liveAssistantBlock.parentNode.removeChild(this._liveAssistantBlock)
    }
    this._liveAssistantBlock = null
    this._liveAssistantId = null
    if (this._liveSubagentBlock) {
      this._liveSubagentBlock.style.opacity = ''
      this._liveSubagentBlock = null
    }
    // P1-5: freeze all live assistant blocks that are now complete so rAF
    // callbacks skip re-running marked.parse() on already-finalized content.
    this._scroll.querySelectorAll('.cbr-block-text.cbr-live').forEach((el) => {
      el.dataset.frozen = '1'
      el.classList.remove('cbr-live')
    })
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
    } else if (part.type === 'thinking') {
      // P1-6: render thinking block as a collapsible faded panel
      this._renderThinkingPart(part.thinking || '')
    } else if (part.type === 'tool_use') {
      this._renderToolUsePart(part)
    } else if (part.type === 'tool_result') {
      this._renderToolResultPart(part)
    }
  }

  _renderThinkingPart(text) {
    if (!text) return
    const charCount = text.length
    const article = this._makeBlock('cbr-block-thinking')
    article.dataset.collapsed = '1'
    article.innerHTML =
      `<div class="cbr-thinking-header" role="button" tabindex="0" aria-expanded="false">` +
      `<svg class="cbr-thinking-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>` +
      `<span class="cbr-thinking-label">Thinking</span>` +
      `<span class="cbr-thinking-count">${charCount.toLocaleString()} chars</span>` +
      `</div>` +
      `<div class="cbr-thinking-body" hidden><pre class="cbr-pre cbr-thinking-pre">${escHtml(text)}</pre></div>`

    const header = article.querySelector('.cbr-thinking-header')
    const body = article.querySelector('.cbr-thinking-body')
    const chevron = article.querySelector('.cbr-thinking-chevron')

    const toggle = () => {
      const collapsed = article.dataset.collapsed === '1'
      if (collapsed) {
        article.dataset.collapsed = '0'
        body.hidden = false
        header.setAttribute('aria-expanded', 'true')
        chevron.style.transform = 'rotate(180deg)'
      } else {
        article.dataset.collapsed = '1'
        body.hidden = true
        header.setAttribute('aria-expanded', 'false')
        chevron.style.transform = ''
      }
    }

    header.addEventListener('click', toggle)
    header.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle() } })

    this._scroll.appendChild(article)
    this._scrollBottom()
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
    // Feature 2 & 3: linkify paths and bare URLs in rendered text nodes
    attachPathAndUrlHandlers(article)
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

    // P2-1: prepend tool icon if available (inline SVG, 16×16)
    const toolIcon = getToolIcon(part.name || '')

    article.innerHTML =
      `<div class="cbr-tool-card">` +
      `<div class="cbr-tool-header">` +
      (toolIcon ? `<span class="cbr-tool-icon-wrap">${toolIcon}</span>` : '') +
      `<span class="cbr-tool-name">${toolName}</span>` +
      (isSubagentTool ? `<span class="cbr-subagent-badge">subagent</span>` : '') +
      (isLoading ? `<span class="cbr-tool-running-badge">running…</span>` : '') +
      `<button class="cbr-tool-fold-btn" type="button" title="Toggle fold" aria-label="Toggle fold">` +
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

    // ── Unified 3-state cycle handler (R17 architecture refactor) ──────────────
    // All Claude tool_use blocks share the same cycle: full → header → line → full
    // (Q2 answer A). The header element is the primary tap/click target.
    // In line mode, the entire article becomes the tap target (min-height 44px).
    //
    // Unified cycle function — works from any state:
    //   full  → header   (fold to header-only)
    //   header → line    (fold to thin stripe)
    //   line  → full     (expand back to full)
    //
    // iOS Safari: touchend fires before the 300ms synthesized click. We use a
    // _touchHandled flag to prevent double-firing. The flag is per-article so
    // header-tap and article-tap don't interfere.
    article.style.cursor = 'pointer'

    let _touchHandled = false

    const _onCycle = (e) => {
      // Suppress if user taps a copy button or link
      const target = e.target
      if (target.closest('.cbr-copy-btn') || target.closest('a') || target.tagName === 'A') return
      cycleToolFold(article)
      e.stopPropagation()
    }

    // Attach to both header AND article so:
    //   - In full/header state: header tap cycles (header is visible)
    //   - In line state: article tap cycles (header is hidden, article = stripe)
    //
    // To avoid double-fire (article click fires after header click bubbles up),
    // headerEl click calls stopPropagation, but we still need article fallback
    // for the line-state where the header is hidden.
    const headerEl = article.querySelector('.cbr-tool-header')

    // Shared touch/click listeners for the header element
    if (headerEl) {
      headerEl.addEventListener('touchstart', () => { _touchHandled = false }, { passive: true })
      headerEl.addEventListener('touchmove', () => { _touchHandled = true }, { passive: true })
      headerEl.addEventListener('touchend', (e) => {
        if (_touchHandled) return
        _touchHandled = true
        _onCycle(e)
        e.preventDefault()
      }, { passive: false })
      headerEl.addEventListener('click', (e) => {
        if (_touchHandled) { _touchHandled = false; return }
        _onCycle(e)
      })
    }

    // Article-level listeners (primary tap target in line state)
    article.addEventListener('touchstart', () => { _touchHandled = false }, { passive: true })
    article.addEventListener('touchmove', () => { _touchHandled = true }, { passive: true })
    article.addEventListener('touchend', (e) => {
      if (_touchHandled) return
      // Only handle at article level when in line state (header invisible)
      // In full/header state the header's own touchend already handled it
      const cur = article.getAttribute('data-fold') || getToolFoldLevel()
      if (cur !== 'line') return
      _touchHandled = true
      _onCycle(e)
      e.preventDefault()
    }, { passive: false })
    article.addEventListener('click', (e) => {
      if (_touchHandled) { _touchHandled = false; return }
      const cur = article.getAttribute('data-fold') || getToolFoldLevel()
      if (cur !== 'line') return  // header already handled non-line states
      _onCycle(e)
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
    // P2-4: collect image items for inline rendering
    const imageItems = []
    if (typeof content === 'string') {
      text = content
    } else if (Array.isArray(content)) {
      const textParts = content.filter((c) => c.type === 'text').map((c) => c.text)
      text = textParts.join('\n')
      for (const c of content) {
        if (c.type === 'image') {
          hasImage = true
          imageItems.push(c)
        }
      }
    }
    // Root B: do NOT silently return on empty/non-text content — always show something
    const displayText = text.trim()
      ? text
      : hasImage
        ? ''
        : content == null
          ? '(no result)'
          : '(empty result)'

    const truncated = displayText.length > 2000
    const displaySlice = truncated ? displayText.slice(0, 2000) + '\n…' : displayText

    // Root C: add error class when is_error is true
    const errorClass = isError ? ' cbr-tool-result--error' : ''

    // P2-4: build image HTML for each image item
    let imageHtml = ''
    for (const img of imageItems) {
      const src = img.source
      if (src && src.type === 'base64' && src.media_type && src.data) {
        imageHtml += `<img class="cbr-inline-img" src="data:${escHtml(src.media_type)};base64,${src.data}" alt="tool image result" loading="lazy">`
      } else if (src && src.type === 'url' && src.url) {
        imageHtml += `<img class="cbr-inline-img" src="${escHtml(src.url)}" alt="tool image result" loading="lazy">`
      }
    }

    const resultHtml =
      `<div class="cbr-tool-result${errorClass}">` +
      (isError ? `<div class="cbr-tool-result-error-label">tool error</div>` : '') +
      (displaySlice ? `<pre class="cbr-pre cbr-tool-result-pre">${escHtml(displaySlice)}</pre>` : '') +
      (imageHtml ? `<div class="cbr-inline-img-wrap">${imageHtml}</div>` : '') +
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

      // R17: attach 3-state cycle handler to standalone result blocks
      article.style.cursor = 'pointer'
      let _resultTouchHandled = false
      const _onResultCycle = (e) => {
        if (e.target.closest('.cbr-copy-btn') || e.target.closest('a') || e.target.tagName === 'A') return
        cycleToolFold(article)
      }
      article.addEventListener('touchstart', () => { _resultTouchHandled = false }, { passive: true })
      article.addEventListener('touchmove', () => { _resultTouchHandled = true }, { passive: true })
      article.addEventListener('touchend', (e) => {
        if (_resultTouchHandled) return
        _resultTouchHandled = true
        _onResultCycle(e)
        e.preventDefault()
      }, { passive: false })
      article.addEventListener('click', (e) => {
        if (_resultTouchHandled) { _resultTouchHandled = false; return }
        _onResultCycle(e)
      })

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
    return article
  }

  _appendUserBlock(text) {
    const article = this._makeBlock('cbr-block-prompt cbr-user-prompt')
    article.innerHTML = `<p class="cbr-prompt-text">&#10095; ${escHtml(text)}</p>`
    attachPathAndUrlHandlers(article)
    this._scroll.appendChild(article)
    this._scrollBottom()
  }

  _scrollBottom() {
    // During replay, skip per-block rAF scroll — _fetchAndReplayHistory does one at the end
    if (this._replayMode) return
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
