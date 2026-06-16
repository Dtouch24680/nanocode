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

/**
 * Attach fold toggle interaction to the header's chevron button only.
 * The surrounding header stays selectable/copyable text.
 */
function _attachFoldToggle(headerEl, article) {
  if (!headerEl) return
  const toggleEl = headerEl.querySelector('.cbx-fold-btn')
  if (!toggleEl) return
  let _touchHandled = false

  const _doToggle = (e) => {
    const cur = article.getAttribute('data-fold') || 'full'
    const next = cur === 'full' ? 'header' : 'full'
    article.setAttribute('data-fold', next)
    toggleEl.setAttribute('aria-expanded', next === 'full' ? 'true' : 'false')
    e.stopPropagation()
  }

  toggleEl.setAttribute('aria-expanded', (article.getAttribute('data-fold') || 'full') === 'full' ? 'true' : 'false')
  toggleEl.addEventListener('touchstart', () => { _touchHandled = false }, { passive: true })
  toggleEl.addEventListener('touchmove', () => { _touchHandled = true }, { passive: true })
  toggleEl.addEventListener('touchend', (e) => {
    if (_touchHandled) return
    _touchHandled = true
    _doToggle(e)
    e.preventDefault()  // prevent delayed synthesized click from firing too
  }, { passive: false })

  toggleEl.addEventListener('click', (e) => {
    if (_touchHandled) { _touchHandled = false; return }
    _doToggle(e)
  })
}

// ── Alt-screen detection ──────────────────────────────────────────────────────
// Codex CLI uses the VT100 alternate screen buffer for its full-screen TUI.
// ESC[?1049h = enter alt-screen (save cursor + switch to alt buffer)
// ESC[?1049l = leave alt-screen (restore cursor + switch back to main buffer)
// We also handle the simpler ESC[?47h/l variants (xterm compat).
const ALT_SCREEN_ENTER_RE = /\x1b\[\?(?:1049|47)h/
const ALT_SCREEN_EXIT_RE  = /\x1b\[\?(?:1049|47)l/

// ── Synchronized Output detection (DEC private mode 2026) ────────────────────
// Codex CLI uses ESC[?2026h...ESC[?2026l to atomically batch screen updates.
// This is NOT the alt-screen buffer — it's in-place screen update batching.
//   ESC[?2026h = begin synchronized update (start buffering a frame)
//   ESC[?2026l = end synchronized update (flush/render frame)
// We detect these boundaries and use VT100Screen to render each frame.
const SYNC_OUTPUT_ENTER_RE = /\x1b\[\?2026h/
const SYNC_OUTPUT_EXIT_RE  = /\x1b\[\?2026l/

// ── Simple VT100 virtual screen (for alt-screen rendering) ────────────────────
// Minimal 2D char buffer that handles:
//   - CSI H / CSI f — cursor position (row;col)
//   - CSI A/B/C/D   — cursor up/down/forward/back
//   - CSI J         — erase in display (0/2/3)
//   - CSI K         — erase in line (0/1/2)
//   - CR (\r)       — carriage return
//   - LF (\n)       — line feed
//   - printable chars — write to buffer at cursor position
//
// Non-printable / color SGR sequences are ignored.
// This is intentionally minimal — good enough for Codex TUI text content.
class VT100Screen {
  constructor(cols = 220, rows = 50) {
    this.cols = cols
    this.rows = rows
    // Each row is a fixed-length array of chars (space-filled).
    this.buf = Array.from({ length: rows }, () => new Array(cols).fill(' '))
    this.cx = 0  // cursor col (0-based)
    this.cy = 0  // cursor row (0-based)
  }

  /** Write raw PTY data into the virtual screen. */
  write(data) {
    let i = 0
    while (i < data.length) {
      const ch = data[i]
      if (ch === '\r') {
        this.cx = 0; i++; continue
      }
      if (ch === '\n') {
        this.cy = Math.min(this.cy + 1, this.rows - 1); i++; continue
      }
      if (ch === '\x1b') {
        // ESC sequence
        const rest = data.slice(i)
        // OSC: ESC ] ... BEL or ST — skip
        if (rest[1] === ']') {
          const end = rest.search(/\x07|\x1b\\/)
          if (end === -1) { i = data.length; break }
          i += end + (rest[end] === '\x07' ? 1 : 2); continue
        }
        // DCS: ESC P ... ST — skip
        if (rest[1] === 'P') {
          const st = rest.indexOf('\x1b\\', 2)
          i += st === -1 ? data.length : st + 2; continue
        }
        // CSI: ESC [
        if (rest[1] === '[') {
          // Allow optional intermediate bytes (0x20-0x2f) before the final byte,
          // e.g. DECSCUSR cursor-shape `ESC [ Ps SP q`. Without this, the space
          // breaks the match and the residual "6 q" leaks as literal text.
          const m = rest.match(/^\x1b\[([0-9;?]*)[ -\/]*([@-~])/)
          if (!m) { i += 2; continue }
          const params = m[1]
          const cmd    = m[2]
          i += m[0].length
          this._csi(cmd, params); continue
        }
        // 2-char ESC sequences: skip
        i += 2; continue
      }
      // Printable char (includes UTF-8 multibyte — treated as 1 cell width for simplicity)
      const code = ch.charCodeAt(0)
      if (code >= 0x20) {
        if (this.cy < this.rows && this.cx < this.cols) {
          this.buf[this.cy][this.cx] = ch
        }
        this.cx++
        if (this.cx >= this.cols) { this.cx = 0; this.cy = Math.min(this.cy + 1, this.rows - 1) }
      }
      i++
    }
  }

  _csi(cmd, params) {
    const nums = params.split(';').map(n => parseInt(n, 10) || 0)
    const n0 = nums[0]
    switch (cmd) {
      case 'H': case 'f': {  // cursor position: row;col (1-based)
        this.cy = Math.max(0, Math.min((nums[0] || 1) - 1, this.rows - 1))
        this.cx = Math.max(0, Math.min((nums[1] || 1) - 1, this.cols - 1))
        break
      }
      case 'A': this.cy = Math.max(0, this.cy - (n0 || 1)); break  // up
      case 'B': this.cy = Math.min(this.rows - 1, this.cy + (n0 || 1)); break  // down
      case 'C': this.cx = Math.min(this.cols - 1, this.cx + (n0 || 1)); break  // right
      case 'D': this.cx = Math.max(0, this.cx - (n0 || 1)); break  // left
      case 'G': this.cx = Math.max(0, Math.min((n0 || 1) - 1, this.cols - 1)); break  // col
      case 'd': this.cy = Math.max(0, Math.min((n0 || 1) - 1, this.rows - 1)); break  // row
      case 'J': {  // erase in display
        if (n0 === 0) {
          // erase from cursor to end of screen
          for (let c = this.cx; c < this.cols; c++) { if (this.buf[this.cy]) this.buf[this.cy][c] = ' ' }
          for (let r = this.cy + 1; r < this.rows; r++) this.buf[r].fill(' ')
        } else if (n0 === 1) {
          // erase from start to cursor
          for (let r = 0; r < this.cy; r++) this.buf[r].fill(' ')
          for (let c = 0; c <= this.cx; c++) { if (this.buf[this.cy]) this.buf[this.cy][c] = ' ' }
        } else {
          // erase entire screen (2 or 3)
          for (const row of this.buf) row.fill(' ')
        }
        break
      }
      case 'K': {  // erase in line
        if (n0 === 0) {
          for (let c = this.cx; c < this.cols; c++) { if (this.buf[this.cy]) this.buf[this.cy][c] = ' ' }
        } else if (n0 === 1) {
          for (let c = 0; c <= this.cx; c++) { if (this.buf[this.cy]) this.buf[this.cy][c] = ' ' }
        } else {
          if (this.buf[this.cy]) this.buf[this.cy].fill(' ')
        }
        break
      }
      case 'P': {  // delete N chars at cursor (shift left)
        const count = n0 || 1
        if (this.buf[this.cy]) {
          const row = this.buf[this.cy]
          row.splice(this.cx, count)
          while (row.length < this.cols) row.push(' ')
        }
        break
      }
      case '@': {  // insert N blank chars at cursor
        const count = n0 || 1
        if (this.buf[this.cy]) {
          const row = this.buf[this.cy]
          for (let k = 0; k < count; k++) row.splice(this.cx, 0, ' ')
          row.length = this.cols
        }
        break
      }
      // SGR (m), cursor save/restore (s/u), private modes (?h/l) — ignore
      default: break
    }
  }

  /** Dump non-empty rows as plain text, trimming trailing whitespace.
   *  N40: collapse runs of >1 consecutive blank line into a single blank
   *  so the alt-screen result block stays visually compact. */
  dump() {
    const lines = []
    for (const row of this.buf) {
      const line = row.join('').trimEnd()
      lines.push(line)
    }
    // Remove trailing blank lines
    while (lines.length > 0 && !lines[lines.length - 1].trim()) lines.pop()
    // N40: collapse consecutive blank lines (≥2 in a row → 1)
    const collapsed = []
    let prevBlank = false
    for (const line of lines) {
      const blank = !line.trim()
      if (blank && prevBlank) continue  // skip duplicate blank
      collapsed.push(line)
      prevBlank = blank
    }
    return collapsed.join('\n')
  }
}

// ── ANSI / rich text rendering ────────────────────────────────────────────────
// Standard CSI sequences: ESC [ ... final-byte
const ANSI_CSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]/g
// OSC sequences: ESC ] ... (BEL or ST)
const ANSI_OSC_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g
// DCS sequences: ESC P ... ST
const ANSI_DCS_RE = /\x1b[P][^\x1b]*(?:\x1b\\)?/g
// Other 2-char ESC sequences: ESC + single char
const ANSI_2CHAR_RE = /\x1b[@-Z\\-_]/g
// Bare BEL (0x07) and other control chars (NUL, SOH, STX, ETX, EOT, ENQ, ACK, SO, SI)
// that slip through after ANSI stripping — keep CR (0x0d) and LF (0x0a)
const BARE_CTRL_RE = /[\x00-\x06\x07\x08\x0e-\x0f\x10-\x1f]/g

function stripAnsi(s) {
  return s
    .replace(ANSI_OSC_RE, '')   // OSC first (contains BEL as terminator)
    .replace(ANSI_DCS_RE, '')   // DCS
    .replace(ANSI_CSI_RE, '')   // CSI (color, cursor, etc.)
    .replace(ANSI_2CHAR_RE, '') // 2-char ESC sequences
    .replace(BARE_CTRL_RE, '')  // stray control chars (BEL, BS, SO, SI, etc.)
}

const ANSI_FG = {
  30: 'black', 31: 'red', 32: 'green', 33: 'yellow', 34: 'blue', 35: 'magenta', 36: 'cyan', 37: 'white',
  90: 'bright-black', 91: 'bright-red', 92: 'bright-green', 93: 'bright-yellow', 94: 'bright-blue', 95: 'bright-magenta', 96: 'bright-cyan', 97: 'bright-white',
}
const ANSI_BG = {
  40: 'black', 41: 'red', 42: 'green', 43: 'yellow', 44: 'blue', 45: 'magenta', 46: 'cyan', 47: 'white',
  100: 'bright-black', 101: 'bright-red', 102: 'bright-green', 103: 'bright-yellow', 104: 'bright-blue', 105: 'bright-magenta', 106: 'bright-cyan', 107: 'bright-white',
}
const SAFE_LINK_PROTOCOLS = new Set(['http:', 'https:', 'file:', 'mailto:', 'vscode:', 'cursor:', 'windsurf:', 'jetbrains:'])

function defaultAnsiState() {
  return {
    bold: false,
    dim: false,
    italic: false,
    underline: false,
    strike: false,
    inverse: false,
    fg: null,
    bg: null,
    href: null,
  }
}

function cloneAnsiState(s) {
  return { ...s, fg: s.fg ? { ...s.fg } : null, bg: s.bg ? { ...s.bg } : null }
}

function clampColor(n) {
  n = Number(n)
  return Number.isFinite(n) ? Math.max(0, Math.min(255, n)) : 0
}

function ansi256ToRgb(n) {
  n = clampColor(n)
  if (n < 16) {
    const base = [
      [0, 0, 0], [205, 49, 49], [13, 188, 121], [229, 229, 16],
      [36, 114, 200], [188, 63, 188], [17, 168, 205], [229, 229, 229],
      [102, 102, 102], [241, 76, 76], [35, 209, 139], [245, 245, 67],
      [59, 142, 234], [214, 112, 214], [41, 184, 219], [255, 255, 255],
    ]
    return base[n]
  }
  if (n >= 232) {
    const v = 8 + (n - 232) * 10
    return [v, v, v]
  }
  const idx = n - 16
  const steps = [0, 95, 135, 175, 215, 255]
  return [steps[Math.floor(idx / 36)], steps[Math.floor(idx / 6) % 6], steps[idx % 6]]
}

function applySgr(params, state) {
  if (!params.length) params = [0]
  for (let i = 0; i < params.length; i++) {
    const p = params[i] === '' ? 0 : Number(params[i])
    if (!Number.isFinite(p)) continue
    if (p === 0) {
      const href = state.href
      Object.assign(state, defaultAnsiState(), { href })
    } else if (p === 1) state.bold = true
    else if (p === 2) state.dim = true
    else if (p === 3) state.italic = true
    else if (p === 4) state.underline = true
    else if (p === 7) state.inverse = true
    else if (p === 9) state.strike = true
    else if (p === 22) { state.bold = false; state.dim = false }
    else if (p === 23) state.italic = false
    else if (p === 24) state.underline = false
    else if (p === 27) state.inverse = false
    else if (p === 29) state.strike = false
    else if (p === 39) state.fg = null
    else if (p === 49) state.bg = null
    else if (ANSI_FG[p]) state.fg = { kind: 'named', value: ANSI_FG[p] }
    else if (ANSI_BG[p]) state.bg = { kind: 'named', value: ANSI_BG[p] }
    else if (p === 38 || p === 48) {
      const target = p === 38 ? 'fg' : 'bg'
      const mode = Number(params[i + 1])
      if (mode === 5 && params[i + 2] != null) {
        state[target] = { kind: 'rgb', value: ansi256ToRgb(Number(params[i + 2])) }
        i += 2
      } else if (mode === 2 && params[i + 4] != null) {
        state[target] = {
          kind: 'rgb',
          value: [clampColor(params[i + 2]), clampColor(params[i + 3]), clampColor(params[i + 4])],
        }
        i += 4
      }
    }
  }
}

function parseOsc8(payload, state) {
  // OSC 8 ; params ; URI  (empty URI closes the active hyperlink)
  if (!payload.startsWith('8;')) return false
  const semi = payload.indexOf(';', 2)
  if (semi < 0) return false
  state.href = payload.slice(semi + 1) || null
  return true
}

function parseAnsiRuns(raw) {
  const runs = []
  const state = defaultAnsiState()
  let buf = ''
  let bufState = cloneAnsiState(state)

  const flush = () => {
    if (!buf) return
    runs.push({ text: buf, state: cloneAnsiState(bufState) })
    buf = ''
  }
  const syncState = () => { bufState = cloneAnsiState(state) }

  let i = 0
  while (i < raw.length) {
    const ch = raw[i]
    if (ch !== '\x1b') {
      const code = ch.charCodeAt(0)
      if (ch === '\n' || ch === '\t' || code >= 0x20) buf += ch
      i++
      continue
    }

    const rest = raw.slice(i)
    if (rest.startsWith('\x1b]')) {
      const bel = rest.indexOf('\x07', 2)
      const st = rest.indexOf('\x1b\\', 2)
      const end = bel < 0 ? st : st < 0 ? bel : Math.min(bel, st)
      if (end < 0) break
      const payload = rest.slice(2, end)
      flush()
      parseOsc8(payload, state)
      syncState()
      i += end + (end === st ? 2 : 1)
      continue
    }

    if (rest.startsWith('\x1b[')) {
      const m = rest.match(/^\x1b\[([0-9;:]*)[ -/]*([@-~])/)
      if (m) {
        flush()
        if (m[2] === 'm') applySgr(m[1].split(/[;:]/), state)
        syncState()
        i += m[0].length
        continue
      }
    }

    if (/^\x1b[P\^_]/.test(rest)) {
      const st = rest.indexOf('\x1b\\', 2)
      i += st < 0 ? rest.length : st + 2
      continue
    }

    // Unknown 2-char escape sequence.
    i += 2
  }
  flush()
  return runs
}

// ── HTML escape ───────────────────────────────────────────────────────────────
function escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// ── URL / path auto-link ──────────────────────────────────────────────────────
const URL_RE = /(?:https?:\/\/|file:\/\/|(?:vscode|cursor|windsurf|jetbrains):\/\/|mailto:)[^\s"'`<>[\]()]+[^\s"'`<>[\]().,;:!?]/gi
const MD_LINK_RE = /\[([^\]\n]{1,180})\]\(([^)\s]+)(?:\s+["'][^)]*["'])?\)/g
// Local file paths are deliberately conservative. Codex CLI itself does not
// link arbitrary git-ref shaped text like "myfork/main"; it mostly relies on
// terminal URL/OSC8 hyperlinks. We only auto-link high-confidence local files.
const PATH_RE = /(?:(?:\/[a-zA-Z0-9_.+@-]+(?:\/[^\s,;!?()[\]"'`<>]+)+)|(?:~\/[^\s,;!?()[\]"'`<>]+)|(?<![:/])(?:(?:\.{1,2}\/)?[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.+-]+)+(?:\.[a-zA-Z0-9_+-]{1,12})?))(?:[:#]\d+(?::\d+)?)?(?=\s|$|[,;!?()[\]"'`<>])/g
const PROJECT_PATH_PREFIXES = new Set([
  '.github', '.openai', 'app', 'bin', 'cmd', 'docs', 'helper', 'lib',
  'packages', 'public', 'qa-test', 'research', 'scripts', 'server',
  'src', 'test', 'tests', 'terminal', 'worker',
])
const TRUSTED_ABSOLUTE_PATH_RE = /^\/(?:storage|home|tmp|var|opt|mnt|workspace|workspaces)\//

function trimTrailingLinkPunctuation(value) {
  let v = String(value)
  while (/[.,;!?`]$/.test(v)) v = v.slice(0, -1)
  return v
}

function splitPathLocation(value) {
  const raw = trimTrailingLinkPunctuation(value)
  const m = raw.match(/^(.*?)(?::(\d+)(?::(\d+))?|#(\d+))$/)
  if (!m) return { path: raw, line: null, column: null }
  return { path: m[1], line: m[2] || m[4] || null, column: m[3] || null }
}

function shouldAutolinkLocalPath(value) {
  const { path, line } = splitPathLocation(value)
  if (TRUSTED_ABSOLUTE_PATH_RE.test(path)) return true
  if (/^(?:\/|~\/|\.{1,2}\/)/.test(path)) return false
  const parts = path.split('/').filter(Boolean)
  if (parts.length < 2) return false
  if (!PROJECT_PATH_PREFIXES.has(parts[0])) return false
  return Boolean(line) || /\.[a-zA-Z0-9_+-]{1,12}$/.test(parts[parts.length - 1])
}

function fileUrlToPath(href) {
  try {
    const u = new URL(href)
    if (u.protocol !== 'file:') return null
    if (u.hostname && u.hostname !== 'localhost') return `//${u.hostname}${decodeURIComponent(u.pathname)}`
    return decodeURIComponent(u.pathname)
  } catch {
    return null
  }
}

function isSafeHref(href) {
  try {
    const u = new URL(href, location.href)
    return SAFE_LINK_PROTOCOLS.has(u.protocol)
  } catch {
    return false
  }
}

function applyAnsiStyle(el, state) {
  if (!state) return el
  const classes = []
  if (state.bold) classes.push('cbx-ansi-bold')
  if (state.dim) classes.push('cbx-ansi-dim')
  if (state.italic) classes.push('cbx-ansi-italic')
  if (state.underline) classes.push('cbx-ansi-underline')
  if (state.strike) classes.push('cbx-ansi-strike')
  if (state.inverse) classes.push('cbx-ansi-inverse')
  if (state.fg?.kind === 'named') classes.push(`cbx-ansi-fg-${state.fg.value}`)
  if (state.bg?.kind === 'named') classes.push(`cbx-ansi-bg-${state.bg.value}`)
  if (classes.length) el.classList.add(...classes)
  if (state.fg?.kind === 'rgb') el.style.color = `rgb(${state.fg.value.join(', ')})`
  if (state.bg?.kind === 'rgb') el.style.backgroundColor = `rgb(${state.bg.value.join(', ')})`
  return el
}

function appendStyledText(parent, text, state) {
  if (!text) return
  const needsSpan = state && (
    state.bold || state.dim || state.italic || state.underline || state.strike ||
    state.inverse || state.fg || state.bg
  )
  if (!needsSpan) {
    parent.appendChild(document.createTextNode(text))
    return
  }
  const span = applyAnsiStyle(document.createElement('span'), state)
  span.textContent = text
  parent.appendChild(span)
}

function createPathLink(label, pathValue, state) {
  const { path, line, column } = splitPathLocation(pathValue)
  const span = applyAnsiStyle(document.createElement('span'), state)
  span.classList.add('cbr-path-link', 'cbx-local-link')
  span.dataset.path = path
  if (line) span.dataset.line = line
  if (column) span.dataset.column = column
  span.title = 'Open in explorer: ' + path + (line ? `:${line}` : '')
  span.textContent = label
  return span
}

function createHrefLink(label, href, state) {
  const filePath = /^file:/i.test(href) ? fileUrlToPath(href) : null
  if (filePath) return createPathLink(label, filePath, state)
  if (!isSafeHref(href)) {
    const span = applyAnsiStyle(document.createElement('span'), state)
    span.textContent = label
    return span
  }
  const a = applyAnsiStyle(document.createElement('a'), state)
  a.href = href
  a.target = '_blank'
  a.rel = 'noopener noreferrer'
  a.classList.add('cbx-url')
  a.textContent = label
  return a
}

/**
 * Append `text` into `el`, turning bare URLs into <a target=_blank> and local
 * file paths into clickable .cbr-path-link spans (data-path). Clicks on the
 * latter are handled by a single delegated listener on the scroll container.
 */
function appendLinkified(el, text) {
  appendRichText(el, text, { ansi: false })
}

function appendRunWithLinks(el, text, state) {
  if (!text) {
    el.appendChild(document.createTextNode(text || ''))
    return
  }
  const matches = []
  let m
  MD_LINK_RE.lastIndex = 0
  while ((m = MD_LINK_RE.exec(text)) !== null) {
    matches.push({ type: 'mdlink', start: m.index, end: m.index + m[0].length, label: m[1], value: trimTrailingLinkPunctuation(m[2]) })
  }
  URL_RE.lastIndex = 0
  while ((m = URL_RE.exec(text)) !== null) {
    const value = trimTrailingLinkPunctuation(m[0])
    matches.push({ type: 'url', start: m.index, end: m.index + value.length, value })
  }
  PATH_RE.lastIndex = 0
  while ((m = PATH_RE.exec(text)) !== null) {
    if (m[0].length > 300) continue
    const value = trimTrailingLinkPunctuation(m[0])
    if (!shouldAutolinkLocalPath(value)) continue
    matches.push({ type: 'path', start: m.index, end: m.index + value.length, value })
  }
  if (!matches.length) {
    appendStyledText(el, text, state)
    return
  }
  matches.sort((a, b) => a.start - b.start)
  let pos = 0
  for (const match of matches) {
    if (match.start < pos) continue // overlap — skip
    if (match.start > pos) appendStyledText(el, text.slice(pos, match.start), state)
    if (match.type === 'url') el.appendChild(createHrefLink(match.value, match.value, state))
    else if (match.type === 'mdlink') {
      if (/^(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(match.value) || /^[a-z][a-z0-9+.-]*:/i.test(match.value)) {
        el.appendChild(createHrefLink(match.label, match.value, state))
      } else {
        el.appendChild(createPathLink(match.label, match.value, state))
      }
    } else el.appendChild(createPathLink(match.value, match.value, state))
    pos = match.end
  }
  if (pos < text.length) appendStyledText(el, text.slice(pos), state)
}

function appendRichText(el, rawText, { ansi = true } = {}) {
  const text = rawText == null ? '' : String(rawText)
  const runs = ansi ? parseAnsiRuns(text) : [{ text, state: defaultAnsiState() }]
  for (const run of runs) {
    if (run.state.href) {
      el.appendChild(createHrefLink(run.text, run.state.href, run.state))
    } else {
      appendRunWithLinks(el, run.text, run.state)
    }
  }
}

function classifyRichLine(rawLine) {
  const line = stripAnsi(rawLine).replace(/\r/g, '')
  if (/^@@/.test(line)) return 'cbx-diff-hunk'
  if (/^(?:diff --git|index |rename from |rename to |new file mode |deleted file mode )/.test(line)) return 'cbx-diff-meta'
  if (/^\+\+\+/.test(line) || /^---/.test(line)) return 'cbx-diff-file'
  if (/^\+/.test(line)) return 'cbx-diff-add'
  if (/^-/.test(line)) return 'cbx-diff-del'
  return ''
}

function renderRichLines(el, text) {
  el.innerHTML = ''
  const lines = String(text || '').split('\n')
  for (const line of lines) {
    const row = document.createElement('div')
    row.className = 'cbx-rich-line'
    const diffCls = classifyRichLine(line)
    if (diffCls) row.classList.add(diffCls)
    appendRichText(row, line)
    el.appendChild(row)
  }
}

function highlightCode(code, lang) {
  try {
    if (window.hljs && lang) {
      return window.hljs.highlight(code, { language: lang, ignoreIllegals: true }).value
    }
    if (window.hljs) return window.hljs.highlightAuto(code).value
  } catch {}
  return escHtml(code)
}

function renderCodexRichMarkdown(el, text) {
  el.innerHTML = ''
  const lines = String(text || '').split('\n')
  let inFence = false
  let fenceLang = ''
  let codeLines = []

  const flushCode = () => {
    const wrap = document.createElement('div')
    wrap.className = 'cbx-code-wrap'
    const code = codeLines.join('\n')
    wrap.innerHTML =
      `<div class="cbx-code-header">${fenceLang ? `<span>${escHtml(fenceLang)}</span>` : ''}</div>` +
      `<pre class="cbx-code-pre"><code class="hljs">${highlightCode(code, fenceLang)}</code></pre>`
    el.appendChild(wrap)
    codeLines = []
  }

  for (const line of lines) {
    const fence = line.match(/^```([a-zA-Z0-9_.+-]*)\s*$/)
    if (fence) {
      if (inFence) {
        flushCode()
        inFence = false
        fenceLang = ''
      } else {
        inFence = true
        fenceLang = fence[1] || ''
        codeLines = []
      }
      continue
    }
    if (inFence) {
      codeLines.push(line)
      continue
    }

    if (!line.trim()) {
      el.appendChild(document.createElement('br'))
      continue
    }

    const heading = line.match(/^(#{1,6})\s+(.+)$/)
    if (heading) {
      const h = document.createElement('div')
      h.className = `cbx-md-heading cbx-md-h${heading[1].length}`
      appendRichText(h, heading[2])
      el.appendChild(h)
      continue
    }

    const list = line.match(/^(\s*)([-*+]|\d+\.)\s+(.+)$/)
    if (list) {
      const row = document.createElement('div')
      row.className = 'cbx-md-list-row'
      const bullet = document.createElement('span')
      bullet.className = 'cbx-md-bullet'
      bullet.textContent = list[2]
      const body = document.createElement('span')
      appendRichText(body, list[3])
      row.style.paddingLeft = `${Math.min(24, list[1].length * 8)}px`
      row.append(bullet, body)
      el.appendChild(row)
      continue
    }

    const quote = line.match(/^>\s?(.*)$/)
    const row = document.createElement('div')
    row.className = quote ? 'cbx-md-line cbx-md-quote' : 'cbx-md-line'
    const diffCls = classifyRichLine(quote ? quote[1] : line)
    if (diffCls) row.classList.add(diffCls)
    appendRichText(row, quote ? quote[1] : line)
    el.appendChild(row)
  }

  if (inFence) {
    flushCode()
  }
}

// ── Pattern detection ─────────────────────────────────────────────────────────
// Codex outputs several distinct line patterns.

// "Working 2m 15s" / "Working..." spinner lines
const STATUS_BANNER_RE = /^(?:Working|Thinking|Analyzing|Planning|Running|Executing|Reviewing)[\s.…]*/i

// Leading spinner/bullet decoration codex prints before the status verb,
// e.g. "• Working (12s • esc to interrupt)" or braille spinner glyphs.
// Stripped before matching STATUS_BANNER_RE so bulleted spinner lines collapse
// into the in-place banner instead of stacking as plain text.
const SPINNER_PREFIX_RE = /^[\s•·●○◦◐◑◒◓⠁-⣿*>+-]+/

// The codex spinner footer always carries this hint — a reliable signal that a
// line is the live "Working (Ns • esc to interrupt)" status, regardless of the
// leading glyph or how the redraw was chunked.
const STATUS_SPINNER_RE = /esc to interrupt/i

// Bare elapsed-seconds remnant left behind when codex repositions the cursor to
// rewrite just the timer ("           12", "30s"). Pure whitespace + a number
// (+ optional 's'). Dropped only while the spinner banner is live, so genuine
// numeric output is never suppressed.
const ELAPSED_FRAGMENT_RE = /^\s*\d{1,4}\s*s?\s*$/

// Partial status-verb fragment from a chunked spinner redraw ("• Worki").
// Matched only while the spinner banner is live.
const STATUS_VERB_PREFIX_RE = /^(?:work|think|analyz|plan|run|execut|review)/i

// Bash command line patterns.
//
// Codex CLI uses › (U+203A) as its native user-input echo prefix:
//   › ls -la           ← codex echoes the user's command
//
// The › prompt is followed by the actual command. We require the next char
// to be a word char or / or ~ or . to avoid matching codex update menu items
// like "› 1. Update now" or "› 2.Skip" (which start with digit+dot).
//
// Codex also spawns an inner bash shell that emits a full shell prompt:
//   user@host:~/path$ cmd          ← after ANSI stripping
//   $ cmd                          ← simplified form
//   > cmd                          ← git / python REPL continuation
//
// The shell-prompt pattern captures everything after the $ so we get
// just the command portion (e.g. "ls qatool/scripts").
// Also handles "[tmux-label] user@host:path$ cmd" (double-echo from OSC title)
const BASH_CMD_RE = /^(?:(?:[›❯])\s+(?=[a-zA-Z/~\.]|\.\.)|\$\s+|Running:\s+|Executing:\s+|bash:\s+|cmd:\s+|(?:[^\s@]+@[^\s:]+:[^\s$]+\$\s+)|(?:\[[^\]]+\]\s+[^\s@]+@[^\s:]+:[^\s$]+\$\s+))/

// Regex to extract just the command part from a shell-prompt line
// matches  "user@host:path$ COMMAND"  →  group 1 = "COMMAND"
// Also handles "[tmux-label] user@host:path$ COMMAND" format
const SHELL_PROMPT_CMD_RE = /(?:\[[^\]]+\]\s+)?[^\s@]+@[^\s:]+:[^\s$]+\$\s+(.*)/

// Lines that are xterm title-set echoes.
// After OSC stripping, some terminals emit TWO copies of the title text —
// one inside the OSC sequence (stripped) and one as literal output.
// The literal form looks like: "[pek-idc] user@host:path$ cmd"
// We detect this as: optional [label] then user@host:path$ — same as a shell
// prompt, so the SHELL_PROMPT_CMD_RE + BASH_CMD_RE handles them correctly.
// Lines starting with bare "0;" or "2;" are raw xterm title remainders.
const XTERM_TITLE_RE = /^(?:0;|\d+;)[a-zA-Z\[]|\x1b\]0;/

// Exit status line: "Exit code: 0" / "exit 0" / "✓ Command succeeded" / "✗ Error"
const EXIT_STATUS_RE = /^(?:exit\s+code\s*[:=]?\s*(\d+)|exit\s+(\d+)|✓|✗|Error:|error:)/i

// apply_patch or file edit patterns
const PATCH_RE = /^(?:apply_patch|edit_file|write_file|create_file|patch:)/i

// Codex "turn" separator
const TURN_SEP_RE = /^[─═]{10,}/

// Box-drawing chars noise filter — codex update notification and TUI borders.
// Two patterns:
//   1. Lines that are purely box-drawing + spaces (╭─╮ ╰─╯ borders)
//   2. Lines that start with │ and contain codex startup info
//      (│ model: ... │ directory: ... │ permissions: ...)
//      These are inside the startup TUI box — shown as a subtler system block.
const BOX_DRAWING_RE = /^[\s╭╮╰╯─│├┤┬┴┼░▒▓]+$/
const BOX_CONTENT_RE = /^[│]\s+(?:>_\s|model:|directory:|permissions:|Tip:|[✨\s]*Update|Run\s+npm)/

// Codex update/tip banner detector — lines like "✨ Update available!" and
// "Tip: NEW: Codex can now..." are startup noise. Show once as a subtle notice.
const UPDATE_NOTICE_RE = /^[✨\s]*Update available!|^Tip:\s/i

// Codex startup noise: npm update spinner (\|/-), npm error output, "See full release"
const STARTUP_NOISE_RE = /^(?:[\\|\/\-]{1,4}$|-?npm\s+(?:error|warn|notice|info)\b|Updating\s+Codex\s+via\b|See\s+full\s+release\s+notes?:|Run\s+npm\s+install)/i

// Codex session info line — extract key info from startup banner lines like
// "│ model:       gpt-5.5 xhigh" → used to show a compact session header
// Capture up to but not including any trailing │ border char
const SESSION_INFO_RE = /^[│]\s+(model|directory|permissions):\s+(.*?)\s*[│]?\s*$/

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

    // Delegated click for path links (URLs are native <a> and need no handler).
    this._scroll.addEventListener('click', (e) => {
      const span = e.target.closest('.cbr-path-link')
      if (!span || !this._scroll.contains(span)) return
      e.stopPropagation()
      document.dispatchEvent(new CustomEvent('nanocode:open-in-explorer', {
        detail: { path: span.dataset.path },
        bubbles: true,
      }))
    })

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

    // Stick-to-bottom: stay pinned to the latest output unless the user has
    // scrolled up. Lets replays (which may render while the tab is hidden) and
    // live output both land at the bottom when the tab becomes visible.
    this._pinToBottom = true
    let _scrollRafPending = false
    this._scroll.addEventListener('scroll', () => {
      if (_scrollRafPending) return
      _scrollRafPending = true
      requestAnimationFrame(() => {
        _scrollRafPending = false
        const s = this._scroll
        this._pinToBottom = s.scrollHeight - s.scrollTop - s.clientHeight < 60
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

    // Update/tip notice dedup — only show once per session
    this._shownUpdateNotice = false

    // P2: Loading indicator — show "Connecting…" until WS ready
    this._connectingEl = document.createElement('div')
    this._connectingEl.className = 'cbx-connecting'
    this._connectingEl.innerHTML =
      `<span class="cbx-connecting-dot"></span>` +
      `<span class="cbx-connecting-text">Connecting to Codex…</span>`
    this._scroll.appendChild(this._connectingEl)

    // ── Alt-screen (VT100 full-screen TUI) state ──────────────────────────────
    // When codex enters its full-screen TUI (ESC[?1049h), we switch to
    // VT100Screen rendering mode. A spinner block is shown while codex works.
    // When alt-screen ends (ESC[?1049l), the final VT100Screen state is dumped
    // as a result block so the user sees what codex produced.
    this._inAltScreen = false
    this._altScreenBuf = ''   // raw (pre-strip) data accumulation while in alt-screen
    this._altScreen = null    // VT100Screen instance while active
    this._altSpinnerEl = null // the spinner/progress block element

    // ── Synchronized Output (ESC[?2026h/l) state ──────────────────────────────
    // Codex CLI uses DEC private mode 2026 to batch screen updates atomically.
    // We buffer each sync frame through a VT100Screen and diff against the
    // previous frame to produce minimal DOM updates (no duplicate welcome screen).
    this._inSyncOutput = false
    this._syncBuf = ''         // raw data accumulation within a sync frame
    this._syncScreen = null    // VT100Screen for current sync frame
    this._prevSyncDump = ''    // last committed frame's dump (for dedup)
    this._syncSpinnerEl = null // shared spinner element while sync is active
    this._syncFrameCount = 0   // total frames committed this session
    this._lastWelcomeBlockEl = null   // reuse welcome block for in-place update
    this._lastResponseBlockEl = null  // reuse response block during rapid-fire frames
    this._lastResponseBlockTs = 0     // timestamp of last response block commit

    // P2: Welcome screen dedup — track content fingerprints already rendered
    this._renderedContentHashes = new Set()

    // Structured SDK item updates are incremental. Keep DOM handles keyed by
    // item id so item.updated refreshes the same visible block instead of
    // waiting for item.completed and then appending a batch of blocks.
    this._agentMessageBlocks = new Map()
    this._reasoningBlocks = new Map()
    this._todoBlocks = new Map()

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
    // Reset response block tracking: new turn always starts a fresh block
    this._lastResponseBlockEl = null
    this._lastResponseBlockTs = 0
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

      // P2: Remove "Connecting…" indicator once first message arrives
      if (this._connectingEl) {
        this._connectingEl.remove()
        this._connectingEl = null
      }

      if (msg.type === 'codex-event') {
        // SDK driver path: render from structured events (live + replay).
        if (msg.event) this._handleCodexEvent(msg.event)
      } else if (msg.type === 'history') {
        // Replay historical PTY data (legacy PTY driver only)
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
   * Process raw PTY data. We handle alt-screen and sync-output transitions
   * BEFORE stripping ANSI. While in either mode, data is fed into a VT100Screen.
   * On exit, the screen is dumped as a result block.
   * Outside special modes, behavior is the original line-by-line processing.
   */
  _handlePtyData(data, fromHistory) {
    if (!data) return

    // N42: History replay — skip TUI rendering entirely.
    // Raw PTY bytes stored in scrollback contain ESC[?1049h/l and ESC[?2026h/l.
    // Re-running the state machine on replay creates phantom spinner/result blocks.
    // Instead, process the saved text lines directly while preserving ANSI SGR.
    if (fromHistory) {
      this._ptybuf += data
      const lines = this._ptybuf.split('\n')
      this._ptybuf = lines.pop() ?? ''
      for (const line of lines) this._processLine(line.replace(/\r/g, ''))
      return
    }

    // ── Sync output (ESC[?2026h/l) boundary detection ───────────────────────
    // Codex CLI uses DEC private mode 2026 for frame-level batching.
    // This takes priority over alt-screen detection.
    if (SYNC_OUTPUT_ENTER_RE.test(data) || SYNC_OUTPUT_EXIT_RE.test(data)) {
      this._handlePtyDataWithSyncOutput(data)
      return
    }

    if (this._inSyncOutput) {
      // Inside a sync frame — buffer to VT100Screen
      this._syncBuf += data
      this._syncScreen.write(data)
      this._updateSyncSpinner()
      return
    }

    // ── Alt-screen boundary detection (pre-ANSI-strip) ──────────────────────
    // Check if there are any alt-screen transitions in this chunk
    if (ALT_SCREEN_ENTER_RE.test(data) || ALT_SCREEN_EXIT_RE.test(data)) {
      // Process segment-by-segment around alt-screen boundaries
      this._handlePtyDataWithAltScreen(data, fromHistory)
      return
    }

    if (this._inAltScreen) {
      // We're inside an alt-screen TUI — feed raw data to virtual screen
      this._altScreenBuf += data
      this._altScreen.write(data)
      // Update spinner to show "still thinking"
      this._updateAltSpinner()
      return
    }

    // Normal path: preserve ANSI SGR for rich rendering, split at line boundaries.
    this._ptybuf += data
    const lines = this._ptybuf.split('\n')
    this._ptybuf = lines.pop() ?? ''
    for (const line of lines) {
      this._processLine(line.replace(/\r/g, ''))
    }
  }

  /**
   * Handle PTY data that contains ESC[?2026h/l (Synchronized Output) boundaries.
   * Each frame is fed through a VT100Screen and the resulting dump is diffed
   * against the previous frame to avoid duplicating content (P2 welcome-screen fix).
   */
  _handlePtyDataWithSyncOutput(data) {
    let pos = 0
    while (pos < data.length) {
      const enterIdx = data.indexOf('\x1b[?2026h', pos)
      const exitIdx  = data.indexOf('\x1b[?2026l', pos)

      const nextEnter = enterIdx >= 0 ? enterIdx : Infinity
      const nextExit  = exitIdx  >= 0 ? exitIdx  : Infinity

      if (nextEnter === Infinity && nextExit === Infinity) {
        // No more boundaries — process remainder in current mode
        const rest = data.slice(pos)
        if (rest) {
          if (this._inSyncOutput) {
            this._syncBuf += rest
            this._syncScreen.write(rest)
            this._updateSyncSpinner()
          } else {
            this._ptybuf += rest
            const lines = this._ptybuf.split('\n')
            this._ptybuf = lines.pop() ?? ''
            for (const line of lines) this._processLine(line.replace(/\r/g, ''))
          }
        }
        break
      }

      if (!this._inSyncOutput && nextEnter < nextExit) {
        // Process text before the enter sequence (normal mode)
        const before = data.slice(pos, nextEnter)
        if (before) {
          this._ptybuf += before
          const lines = this._ptybuf.split('\n')
          this._ptybuf = lines.pop() ?? ''
          for (const line of lines) this._processLine(line.replace(/\r/g, ''))
        }
        // Enter sync mode
        this._enterSyncOutput()
        pos = nextEnter + 8  // '\x1b[?2026h'.length === 8
      } else if (this._inSyncOutput && nextExit < nextEnter) {
        // Feed data up to exit sequence into VT100Screen
        const before = data.slice(pos, nextExit)
        if (before) {
          this._syncBuf += before
          this._syncScreen.write(before)
        }
        // Exit sync mode — commit the frame
        this._exitSyncOutput()
        pos = nextExit + 8  // '\x1b[?2026l'.length === 8
      } else if (!this._inSyncOutput && nextExit <= nextEnter) {
        // Spurious exit while not in sync mode — skip
        pos = nextExit + 8
      } else {
        // Spurious enter while already in sync mode — skip
        pos = nextEnter + 8
      }
    }
  }

  /** Called when ESC[?2026h is received — begin synchronized output frame. */
  _enterSyncOutput() {
    if (this._inSyncOutput) return
    this._inSyncOutput = true
    this._syncBuf = ''
    this._syncScreen = new VT100Screen(220, 50)
    // Don't create a spinner for every frame; only on first active frame
    if (this._syncFrameCount === 0) {
      this._setThinking(true)
      this._showSyncSpinner()
    }
  }

  /** Called when ESC[?2026l is received — commit the synchronized output frame. */
  _exitSyncOutput() {
    if (!this._inSyncOutput) return
    this._inSyncOutput = false
    this._syncFrameCount++

    const dump = this._syncScreen ? this._syncScreen.dump() : ''
    this._syncScreen = null
    this._syncBuf = ''

    if (!dump || !dump.trim()) return

    // P2: Dedup frames — if this frame is identical to the last, skip
    if (dump === this._prevSyncDump) return
    this._prevSyncDump = dump

    // Remove the spinner once we get actual content
    this._clearSyncSpinner()

    // Determine if this is a codex welcome/startup screen
    const isWelcomeScreen = /OpenAI Codex|model:\s+\S|YOLO mode|context left/i.test(dump)
    const isSpinnerFrame = /Working\s+\d|Analyzing|Thinking\.\.\./i.test(dump) && dump.length < 200

    if (isSpinnerFrame) {
      // Show as a status banner update, not a full block
      const firstLine = dump.split('\n').find(l => l.trim()) || dump.slice(0, 80)
      this._updateStatusBanner(firstLine.trim())
      this._setThinking(true)
      return
    }

    // Welcome/startup frames: replace the previous welcome block in-place instead
    // of appending. Codex 0.134+ sends many startup frames during startup;
    // appending all of them creates DOM pollution. Replace in-place so the startup
    // sequence resolves to exactly one welcome block showing the final state.
    if (isWelcomeScreen && this._lastWelcomeBlockEl && this._lastWelcomeBlockEl.isConnected) {
      this._updateSyncScreenResultBlock(this._lastWelcomeBlockEl, dump)
      this._scrollBottom()
      return
    }

    // Non-welcome frames: check fingerprint dedup to avoid rendering duplicate
    // response frames (e.g. same result shown twice after interruption).
    if (!isWelcomeScreen) {
      const fingerprint = dump.slice(0, 200)
      if (this._renderedContentHashes.has(fingerprint)) return
      this._renderedContentHashes.add(fingerprint)
    }

    // Non-welcome response frames that arrive rapidly (within 300ms of the last
    // block): replace the last response block in-place. Codex 0.134+ animates
    // text character-by-character during startup, producing dozens of
    // nearly-identical frames in a burst. Replacing in-place keeps DOM clean.
    const now = Date.now()
    if (!isWelcomeScreen &&
        this._lastResponseBlockEl &&
        this._lastResponseBlockEl.isConnected &&
        now - this._lastResponseBlockTs < 300) {
      this._updateSyncScreenResultBlock(this._lastResponseBlockEl, dump)
      this._lastResponseBlockTs = now
      this._scrollBottom()
      return
    }

    // Render as a sync-screen result block (same style as alt-screen)
    const blockEl = this._addSyncScreenResultBlock(dump, isWelcomeScreen)
    if (isWelcomeScreen) {
      this._lastWelcomeBlockEl = blockEl
    } else {
      // Track the latest response block for rapid-frame replacement
      this._lastResponseBlockEl = blockEl
      this._lastResponseBlockTs = now
    }

    if (!isWelcomeScreen) {
      this._setThinking(false)
    }
  }

  /** Show (or reuse) a spinner indicating sync output is active. */
  _showSyncSpinner() {
    if (!this._syncSpinnerEl) {
      const el = document.createElement('div')
      el.className = 'cbx-alt-spinner cbx-sync-spinner'
      el.innerHTML =
        `<span class="cbx-alt-spinner-dot"></span>` +
        `<span class="cbx-alt-spinner-text">Codex thinking…</span>` +
        `<span class="cbx-alt-spinner-hint"></span>`
      this._scroll.appendChild(el)
      this._syncSpinnerEl = el
    }
    this._scrollBottom()
  }

  /** Update the sync spinner with activity feedback. */
  _updateSyncSpinner() {
    if (this._syncSpinnerEl) {
      const now = Date.now()
      if (!this._syncSpinnerLastUpdate || now - this._syncSpinnerLastUpdate > 500) {
        this._syncSpinnerLastUpdate = now
        const dots = '.'.repeat(((now / 500) | 0) % 4)
        const hint = this._syncSpinnerEl.querySelector('.cbx-alt-spinner-hint')
        if (hint) hint.textContent = `（sync frame ${this._syncFrameCount}${dots}）`
        this._scrollBottom()
      }
    }
  }

  /** Remove the sync output spinner. */
  _clearSyncSpinner() {
    if (this._syncSpinnerEl) {
      this._syncSpinnerEl.remove()
      this._syncSpinnerEl = null
    }
    this._syncSpinnerLastUpdate = 0
  }

  /**
   * Render a synchronized output frame dump as a collapsible block.
   * P3: Each line in the dump is rendered as a separate <div> for proper
   * line breaks — the dump may contain \n but we need explicit DOM elements.
   */
  _addSyncScreenResultBlock(text, isWelcome = false) {
    // Clear any status banner
    if (this._statusBannerEl) {
      this._statusBannerEl.remove()
      this._statusBannerEl = null
    }

    const blockClass = isWelcome ? 'cbx-block-sync cbx-block-sync-welcome' : 'cbx-block-sync'
    const article = this._makeBlock(blockClass)
    const foldLevel = isWelcome ? 'header' : getFoldLevel()
    article.setAttribute('data-fold', foldLevel)

    const labelText = isWelcome ? 'Codex Welcome' : 'Codex Response'
    const iconText = isWelcome ? '🖥' : '◈'

    article.innerHTML =
      `<div class="cbx-altscreen-card">` +
      `<div class="cbx-altscreen-header">` +
      `<span class="cbx-altscreen-icon">${iconText}</span>` +
      `<span class="cbx-altscreen-label">${labelText}</span>` +
      (isWelcome ? '' : `<span class="cbx-altscreen-done">✓ done</span>`) +
      `<button class="cbx-fold-btn" type="button" title="Toggle fold" aria-label="Toggle fold">` +
      `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>` +
      `</button>` +
      `</div>` +
      `<div class="cbx-altscreen-body cbx-sync-body"></div>` +
      `</div>`

    // P3: Render each line as a separate div for proper line breaks
    const bodyEl = article.querySelector('.cbx-sync-body')
    const lines = text.split('\n')
    for (const line of lines) {
      const lineEl = document.createElement('div')
      lineEl.className = 'cbx-sync-line'
      const diffCls = classifyRichLine(line)
      if (diffCls) lineEl.classList.add(diffCls)
      appendLinkified(lineEl, line)  // safe — builds text/anchor/span DOM nodes
      bodyEl.appendChild(lineEl)
    }

    // Click/touch header to toggle fold: full ↔ header
    const header = article.querySelector('.cbx-altscreen-header')
    _attachFoldToggle(header, article)

    this._scroll.appendChild(article)
    this._scrollBottom()
    return article
  }

  /**
   * Update an existing sync-screen result block in-place (for welcome screen
   * in-place refresh — avoids appending new blocks for each startup frame).
   */
  _updateSyncScreenResultBlock(article, text) {
    const bodyEl = article.querySelector('.cbx-sync-body')
    if (!bodyEl) return
    bodyEl.innerHTML = ''
    const lines = text.split('\n')
    for (const line of lines) {
      const lineEl = document.createElement('div')
      lineEl.className = 'cbx-sync-line'
      const diffCls = classifyRichLine(line)
      if (diffCls) lineEl.classList.add(diffCls)
      appendLinkified(lineEl, line)
      bodyEl.appendChild(lineEl)
    }
  }

  /**
   * Handle PTY data that contains alt-screen enter or exit sequences.
   * Splits the chunk on boundary sequences and processes each segment
   * in the correct mode (normal vs alt-screen).
   */
  _handlePtyDataWithAltScreen(data, fromHistory) {
    // Split on alt-screen enter/exit, keeping the delimiters
    // We walk through the data finding ESC[?1049h and ESC[?1049l sequences.
    let pos = 0
    while (pos < data.length) {
      // Find next alt-screen sequence
      const enterIdx = data.indexOf('\x1b[?1049h', pos)
      const exitIdx  = data.indexOf('\x1b[?1049l', pos)
      // Also handle ESC[?47h/l variants
      const enter47Idx = data.indexOf('\x1b[?47h', pos)
      const exit47Idx  = data.indexOf('\x1b[?47l', pos)

      // Determine the nearest event
      const nextEnter = Math.min(
        enterIdx  >= 0 ? enterIdx  : Infinity,
        enter47Idx >= 0 ? enter47Idx : Infinity,
      )
      const nextExit = Math.min(
        exitIdx  >= 0 ? exitIdx  : Infinity,
        exit47Idx >= 0 ? exit47Idx : Infinity,
      )

      if (nextEnter === Infinity && nextExit === Infinity) {
        // No more boundaries — process rest in current mode
        const rest = data.slice(pos)
        if (rest) {
          if (this._inAltScreen) {
            this._altScreenBuf += rest
            this._altScreen.write(rest)
            this._updateAltSpinner()
          } else {
            this._ptybuf += rest
            const lines = this._ptybuf.split('\n')
            this._ptybuf = lines.pop() ?? ''
            for (const line of lines) this._processLine(line.replace(/\r/g, ''))
          }
        }
        break
      }

      if (!this._inAltScreen && nextEnter < nextExit) {
        // Process normal data before the enter sequence
        const before = data.slice(pos, nextEnter)
        if (before) {
          this._ptybuf += before
          const lines = this._ptybuf.split('\n')
          this._ptybuf = lines.pop() ?? ''
          for (const line of lines) this._processLine(line.replace(/\r/g, ''))
        }
        // Enter alt-screen
        this._enterAltScreen()
        const seqLen = data[nextEnter + 2] === '?' && data.slice(nextEnter).startsWith('\x1b[?1049h') ? 8 : 6
        pos = nextEnter + seqLen
      } else if (this._inAltScreen && nextExit < nextEnter) {
        // Feed alt-screen data up to the exit sequence
        const before = data.slice(pos, nextExit)
        if (before) {
          this._altScreenBuf += before
          this._altScreen.write(before)
        }
        // Exit alt-screen — finalize and render
        const seqLen = data.slice(nextExit).startsWith('\x1b[?1049l') ? 8 : 6
        pos = nextExit + seqLen
        // Capture any data that follows on the same chunk (main-screen content)
        this._exitAltScreen()
      } else if (!this._inAltScreen && nextExit <= nextEnter) {
        // Spurious exit while not in alt-screen — skip sequence
        const seqLen = data.slice(nextExit).startsWith('\x1b[?1049l') ? 8 : 6
        pos = nextExit + seqLen
      } else {
        // Spurious enter while already in alt-screen — skip sequence
        const seqLen = data.slice(nextEnter).startsWith('\x1b[?1049h') ? 8 : 6
        pos = nextEnter + seqLen
      }
    }
  }

  /** Called when ESC[?1049h is received — codex enters full-screen TUI. */
  _enterAltScreen() {
    if (this._inAltScreen) return
    this._inAltScreen = true
    this._altScreenBuf = ''
    this._altScreen = new VT100Screen(220, 50)
    this._finalizeCurrentBlock()
    this._setThinking(true)
    // Show a progress spinner block
    this._showAltSpinner()
  }

  /** Called when ESC[?1049l is received — codex leaves full-screen TUI. */
  _exitAltScreen() {
    if (!this._inAltScreen) return
    this._inAltScreen = false
    const screenDump = this._altScreen ? this._altScreen.dump() : ''
    this._altScreen = null
    this._altScreenBuf = ''

    // Remove the spinner
    this._clearAltSpinner()

    // Render the screen dump as a result block (if non-empty content)
    if (screenDump && screenDump.trim()) {
      this._addAltScreenResultBlock(screenDump)
    }

    this._setThinking(false)
  }

  /** Show (or update) the "Codex thinking..." spinner block. */
  _showAltSpinner() {
    if (!this._altSpinnerEl) {
      const el = document.createElement('div')
      el.className = 'cbx-alt-spinner'
      el.innerHTML =
        `<span class="cbx-alt-spinner-dot"></span>` +
        `<span class="cbx-alt-spinner-text">Codex thinking…</span>` +
        `<span class="cbx-alt-spinner-hint">（全屏 TUI 渲染中）</span>`
      this._scroll.appendChild(el)
      this._altSpinnerEl = el
    }
    this._scrollBottom()
  }

  /** Update the alt-screen spinner to indicate ongoing activity. */
  _updateAltSpinner() {
    if (this._altSpinnerEl) {
      const now = Date.now()
      if (!this._altSpinnerLastUpdate || now - this._altSpinnerLastUpdate > 500) {
        this._altSpinnerLastUpdate = now
        const dots = '.'.repeat(((now / 500) | 0) % 4)
        const hint = this._altSpinnerEl.querySelector('.cbx-alt-spinner-hint')
        if (hint) hint.textContent = `（全屏 TUI 渲染中${dots}）`
        this._scrollBottom()
      }
    }
  }

  /** Remove the alt-screen spinner block. */
  _clearAltSpinner() {
    if (this._altSpinnerEl) {
      this._altSpinnerEl.remove()
      this._altSpinnerEl = null
    }
    this._altSpinnerLastUpdate = 0
  }

  /**
   * Render the alt-screen dump as a collapsible result block.
   * The screen dump is the final visual state of codex's TUI —
   * includes reasoning, tool calls, file changes, etc.
   */
  _addAltScreenResultBlock(text) {
    // Clear any status banner
    if (this._statusBannerEl) {
      this._statusBannerEl.remove()
      this._statusBannerEl = null
    }

    const article = this._makeBlock('cbx-block-altscreen')
    const foldLevel = getFoldLevel()
    article.setAttribute('data-fold', foldLevel)

    article.innerHTML =
      `<div class="cbx-altscreen-card">` +
      `<div class="cbx-altscreen-header">` +
      `<span class="cbx-altscreen-icon">◈</span>` +
      `<span class="cbx-altscreen-label">Codex Response</span>` +
      `<span class="cbx-altscreen-done">✓ done</span>` +
      `<button class="cbx-fold-btn" type="button" title="Toggle fold" aria-label="Toggle fold">` +
      `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>` +
      `</button>` +
      `</div>` +
      `<div class="cbx-altscreen-body"></div>` +
      `</div>`

    renderRichLines(article.querySelector('.cbx-altscreen-body'), text)

    // Click/touch header to toggle fold: full ↔ header
    const header = article.querySelector('.cbx-altscreen-header')
    _attachFoldToggle(header, article)

    this._scroll.appendChild(article)
    this._scrollBottom()
  }

  _processLine(rawLine) {
    const line = stripAnsi(rawLine).replace(/\r/g, '')
    if (!line.trim()) {
      // Blank line: may indicate block boundary
      if (this._currentBashBlock) {
        // Add blank line to current bash output
        this._appendToBashOutput('')
      }
      return
    }

    // ── Filter noise lines ───────────────────────────────────────────────────────
    // xterm title-set echoes: "0;[pek-idc] hostname~/path$ cmd" or "\e]0;..."
    // These are OSC 0 remnants that survive ANSI stripping — silently discard.
    if (XTERM_TITLE_RE.test(line)) {
      return
    }

    // Box-drawing char lines (╭─╮ │ ╰─╯ borders from codex update/startup TUI) — noise.
    if (BOX_DRAWING_RE.test(line)) {
      return
    }

    // Codex startup info lines inside the TUI box (│ model: ... │ directory: ...)
    // Extract key=value and accumulate into a compact session-info block.
    if (BOX_CONTENT_RE.test(line) && !this._currentBashBlock) {
      const m = SESSION_INFO_RE.exec(line)
      if (m) {
        this._accumulateSessionInfo(m[1].trim(), m[2].trim())
      }
      // drop the line regardless (either accumulated or just visual)
      return
    }

    // Codex startup noise: npm spinner / npm error lines / "Updating Codex via…"
    // These appear before the codex TUI starts and are visual clutter.
    if (STARTUP_NOISE_RE.test(line) && !this._currentBashBlock) {
      return
    }

    // Codex startup tips — "Tip: NEW: …" — silently drop; not task-relevant.
    if (UPDATE_NOTICE_RE.test(line) && !this._currentBashBlock) {
      // Show update notice as subtle system block once
      if (!this._shownUpdateNotice) {
        this._shownUpdateNotice = true
        this._addSystemBlock(line.trim())
      }
      return
    }

    // Status banner (Working / Thinking) — update in-place.
    // Strip any leading spinner glyph first ("• Working (12s • esc to interrupt)")
    // and also treat the "esc to interrupt" footer as a spinner line, so codex's
    // live status collapses into ONE in-place banner instead of stacking a new
    // line on every redraw frame.
    const deco = line.replace(SPINNER_PREFIX_RE, '')
    if (STATUS_SPINNER_RE.test(line) || STATUS_BANNER_RE.test(deco)) {
      this._updateStatusBanner(deco.trim() || 'Working')
      this._setThinking(true)
      return
    }

    // While the spinner banner is live, codex keeps repositioning the cursor to
    // rewrite the elapsed timer and re-emits status-verb fragments. With cursor
    // moves stripped these would cascade as junk lines — drop them.
    if (this._statusBannerEl &&
        (ELAPSED_FRAGMENT_RE.test(line) || STATUS_VERB_PREFIX_RE.test(deco))) {
      return
    }

    // Turn separator ─────────
    if (TURN_SEP_RE.test(line)) {
      this._finalizeCurrentBlock()
      this._setThinking(false)
      this._statusBannerEl = null
      return
    }

    // Bash command line (› prompt, ❯ prompt, $ prompt, user@host:path$ prompt)
    if (BASH_CMD_RE.test(line)) {
      this._finalizeCurrentBlock()

      // For full shell-prompt lines like "user@host:path$ cmd", extract just "cmd"
      const shellMatch = SHELL_PROMPT_CMD_RE.exec(line)
      const cmd = shellMatch ? shellMatch[1].trim() : line.replace(BASH_CMD_RE, '').trim()

      if (cmd) {
        this._startBashBlock(cmd)
      }
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

    // If we're inside a bash block, this is output — but still suppress
    // codex startup noise (npm spinner/errors, TUI box-drawing) that arrive
    // as bash output while codex itself is initialising (auto-updating, etc.)
    if (this._currentBashBlock) {
      if (BOX_DRAWING_RE.test(line) || BOX_CONTENT_RE.test(line) || STARTUP_NOISE_RE.test(line)) {
        // Extract session info even when inside a bash block
        const m = SESSION_INFO_RE.exec(line)
        if (m) this._accumulateSessionInfo(m[1].trim(), m[2].trim())
        return
      }
      this._appendToBashOutput(rawLine)
      return
    }

    // General text — show as response text
    this._appendTextLine(rawLine)
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

    article.innerHTML =
      `<div class="cbx-bash-card">` +
      `<div class="cbx-bash-header">` +
      `<span class="cbx-bash-icon">$</span>` +
      `<span class="cbx-bash-cmd-text"><code class="cbx-bash-cmd"></code></span>` +
      `<span class="cbx-bash-status cbx-bash-running">running…</span>` +
      `<button class="cbx-fold-btn" type="button" title="Toggle fold" aria-label="Toggle fold">` +
      `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>` +
      `</button>` +
      `</div>` +
      `<div class="cbx-bash-output cbx-bash-body"></div>` +
      `</div>`

    appendRichText(article.querySelector('.cbx-bash-cmd'), cmd, { ansi: false })

    // Click/touch header to toggle fold: full ↔ header
    const header = article.querySelector('.cbx-bash-header')
    _attachFoldToggle(header, article)

    this._scroll.appendChild(article)
    this._scrollBottom()

    this._currentBashBlock = {
      article,
      cmd,
      outputEl: article.querySelector('.cbx-bash-output'),
      outputLines: [],
      outputText: '',
    }
  }

  _appendToBashOutput(line) {
    if (!this._currentBashBlock) return
    this._currentBashBlock.outputLines.push(line)
    this._currentBashBlock.outputText = this._currentBashBlock.outputLines.join('\n')
    this._renderCurrentBashOutput()
  }

  _setBashOutputText(text) {
    if (!this._currentBashBlock) return
    const value = String(text || '')
    if (this._currentBashBlock.outputText === value) return
    this._currentBashBlock.outputText = value
    this._currentBashBlock.outputLines = value ? value.split('\n') : []
    this._renderCurrentBashOutput()
  }

  _renderCurrentBashOutput() {
    if (!this._currentBashBlock) return
    const lines = this._currentBashBlock.outputLines || []
    const text = this._currentBashBlock.outputText || lines.join('\n')
    const MAX_CHARS = 4000
    const MAX_LINES = 80
    const isTooLong = text.length > MAX_CHARS || lines.length > MAX_LINES
    let display
    if (isTooLong) {
      // Show first MAX_LINES lines only, with a clear truncation notice
      const kept = lines.slice(0, MAX_LINES)
      const dropped = lines.length - kept.length
      const keptText = kept.join('\n').slice(0, MAX_CHARS)
      display = keptText + `\n\n… [${dropped} more lines hidden — scroll terminal for full output]`
    } else {
      display = text
    }
    renderRichLines(this._currentBashBlock.outputEl, display)
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
        statusEl.remove()
      } else {
        statusEl.className = 'cbx-bash-status cbx-bash-err'
        statusEl.textContent = `✗ exit ${exitCode}`
      }
    }

    this._currentBashBlock = null
    this._setThinking(false)
  }

  // ── Structured codex-event rendering (SDK driver) ──────────────────────────────
  //
  // The SDK driver broadcasts typed events ({type:'item.started'|'item.completed'|
  // 'turn.completed'|...}) instead of flattened text. We render each item type as a
  // dedicated block, reusing the same builders as the legacy text path. This gives
  // proper structure (command cards, patch badges, message/reasoning blocks) and lets
  // us cap noisy output (e.g. command stdout) instead of dumping whole files.
  _handleCodexEvent(event) {
    if (!event || !event.type) return
    const t = event.type

    if (t === 'clear') {
      this._scroll.innerHTML = ''
      this._currentBashBlock = null
      this._statusBannerEl = null
      this._agentMessageBlocks.clear()
      this._reasoningBlocks.clear()
      this._todoBlocks.clear()
      this._setThinking(false)
      return
    }
    if (t === 'turn.started') {
      this._agentMessageBlocks.clear()
      this._reasoningBlocks.clear()
      this._todoBlocks.clear()
      this._setThinking(true)
      return
    }
    if (t === 'thread.started') return

    if (t === 'user_prompt') {
      // Synthetic, replay-only event so the user's prompt survives refresh.
      this._finalizeCurrentBlock()
      this._appendUserBlock(event.text || '')
      return
    }
    if (t === 'notice') {
      this._addSystemBlock(event.text || '')
      return
    }

    if (t === 'item.started') {
      const item = event.item
      if (item?.type === 'command_execution' && item.command) {
        this._updateCommandExecution(item)
      } else if (item?.type === 'file_change') {
        this._renderFileChange(item)
      } else if (item?.type === 'agent_message') {
        this._upsertAgentMessageBlock(item)
      } else if (item?.type === 'reasoning') {
        this._upsertReasoningBlock(item)
      } else if (item?.type === 'todo_list') {
        this._upsertTodoList(item)
      }
      return
    }

    if (t === 'item.updated') {
      const item = event.item
      if (!item) return
      if (item.type === 'command_execution') {
        this._updateCommandExecution(item)
      } else if (item.type === 'agent_message') {
        this._upsertAgentMessageBlock(item)
      } else if (item.type === 'reasoning') {
        this._upsertReasoningBlock(item)
      } else if (item.type === 'todo_list') {
        this._upsertTodoList(item)
      }
      return
    }

    if (t === 'item.completed') {
      const item = event.item
      if (!item) return
      if (item.type === 'command_execution') {
        this._completeCommand(item)
      } else if (item.type === 'file_change') {
        this._renderFileChange(item)
      } else if (item.type === 'agent_message') {
        this._finalizeCurrentBlock()
        this._setThinking(false)
        this._upsertAgentMessageBlock(item, { final: true })
      } else if (item.type === 'reasoning') {
        this._upsertReasoningBlock(item, { final: true })
      } else if (item.type === 'web_search') {
        this._addSystemBlock(`🔎 web search: ${item.query || ''}`)
      } else if (item.type === 'mcp_tool_call') {
        const label = `${item.server || 'mcp'}/${item.tool || 'tool'}`
        this._addSystemBlock(`🔧 ${label}${item.status === 'failed' ? ' (failed)' : ''}`)
      } else if (item.type === 'todo_list') {
        this._upsertTodoList(item, { final: true })
      } else if (item.type === 'error') {
        this._addSystemBlock(`[Error: ${item.message || 'unknown'}]`)
      }
      return
    }

    if (t === 'turn.completed') {
      this._finalizeCurrentBlock()
      this._setThinking(false)
      this._addTurnSeparator()
      return
    }
    if (t === 'turn.failed') {
      this._finalizeCurrentBlock()
      this._setThinking(false)
      this._addSystemBlock(`[Error: ${event.error?.message || 'Codex turn failed'}]`)
      this._addTurnSeparator()
      return
    }
    if (t === 'error') {
      this._finalizeCurrentBlock()
      this._setThinking(false)
      this._addSystemBlock(`[Error: ${event.message || 'Codex stream error'}]`)
      this._addTurnSeparator()
    }
  }

  _updateCommandExecution(item) {
    // The command may complete without a preceding item.started (e.g. on replay
    // when the started event was trimmed) — start a block on demand.
    if (!this._currentBashBlock || this._currentBashBlock.cmd !== item.command) {
      this._finalizeCurrentBlock()
      this._startBashBlock(item.command || '')
    }
    const output = item.aggregated_output || ''
    this._setBashOutputText(output)
  }

  _completeCommand(item) {
    this._updateCommandExecution(item)
    const code = item.exit_code
    const failed = item.status === 'failed'
    this._finalizeBashBlockWithExit(code == null ? (failed ? 'exit ?' : 'exit 0') : `exit ${code}`)
  }

  _renderFileChange(item) {
    // Render once, on completion only (item.started for file_change carries no extra info).
    if (item.status == null && item.changes == null) return
    if (item._nanocodeRendered) return
    for (const change of item.changes || []) {
      this._addPatchBlock(change.kind || 'update', change.path || '', item.status)
    }
    item._nanocodeRendered = true
  }

  _upsertTodoList(item, { final = false } = {}) {
    const items = item.items || []
    if (!items.length) return
    const id = item.id || ''
    let article = id ? this._todoBlocks.get(id) : null
    if (!article || !article.isConnected) {
      article = this._makeBlock('cbx-block-todo')
      this._scroll.appendChild(article)
      if (id) this._todoBlocks.set(id, article)
    }
    article.innerHTML = ''
    const ul = document.createElement('ul')
    ul.className = 'cbx-todo-list'
    for (const todo of items) {
      const li = document.createElement('li')
      if (todo.completed) li.className = 'cbx-todo-done'
      li.appendChild(document.createTextNode(todo.completed ? '☑ ' : '☐ '))
      appendRichText(li, todo.text || '', { ansi: false })
      ul.appendChild(li)
    }
    article.appendChild(ul)
    this._scrollBottom()
    if (final && id) this._todoBlocks.set(id, article)
  }

  _addAgentMessageBlock(text) {
    const article = this._makeBlock('cbx-block-text cbx-block-message')
    article._cbxTextRaw = text
    const body = document.createElement('div')
    body.className = 'cbx-text-pre cbx-rich-text'
    renderCodexRichMarkdown(body, text)
    article.appendChild(body)
    this._scroll.appendChild(article)
    this._scrollBottom()
    return article
  }

  _upsertAgentMessageBlock(item, { final = false } = {}) {
    const text = item.text || ''
    const id = item.id || ''
    if (!id) {
      this._addAgentMessageBlock(text)
      return
    }

    let article = this._agentMessageBlocks.get(id)
    if (!article || !article.isConnected) {
      article = this._addAgentMessageBlock(text)
      this._agentMessageBlocks.set(id, article)
      return
    }

    article._cbxTextRaw = text
    const body = article.querySelector('.cbx-text-pre')
    if (body) renderCodexRichMarkdown(body, text)
    this._scrollBottom()
    if (final) this._agentMessageBlocks.set(id, article)
  }

  _addReasoningBlock(text) {
    return this._upsertReasoningBlock({ id: '', text })
  }

  _upsertReasoningBlock(item, { final = false } = {}) {
    const text = item.text || ''
    if (!text || !text.trim()) return
    const id = item.id || ''
    let article = id ? this._reasoningBlocks.get(id) : null
    if (!article || !article.isConnected) {
      article = this._makeBlock('cbx-block-reasoning')
      article.setAttribute('data-fold', 'header')
      article.innerHTML =
        `<div class="cbx-reasoning-header">` +
        `<span class="cbx-reasoning-icon">💭</span>` +
        `<span class="cbx-reasoning-label">thinking</span>` +
        `<button class="cbx-fold-btn" type="button" title="Toggle fold" aria-label="Toggle fold">` +
        `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>` +
        `</button></div>` +
        `<div class="cbx-reasoning-body cbx-text-pre"></div>`
      const header = article.querySelector('.cbx-reasoning-header')
      _attachFoldToggle(header, article)
      this._scroll.appendChild(article)
      if (id) this._reasoningBlocks.set(id, article)
    }

    renderRichLines(article.querySelector('.cbx-reasoning-body'), text)
    this._scrollBottom()
    if (final && id) this._reasoningBlocks.set(id, article)
    return article
  }

  _addTurnSeparator() {
    const last = this._scroll.lastElementChild
    if (last && last.classList.contains('cbx-turn-sep')) return
    const sep = this._makeBlock('cbx-turn-sep')
    this._scroll.appendChild(sep)
    this._scrollBottom()
  }

  _finalizeCurrentBlock() {
    if (!this._currentBashBlock) return
    const { article } = this._currentBashBlock
    const statusEl = article.querySelector('.cbx-bash-status')
    if (statusEl && statusEl.classList.contains('cbx-bash-running')) {
      statusEl.remove()
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
    if (!isError) return
    const article = this._makeBlock('cbx-block-exit')
    article.innerHTML =
      `<span class="cbx-exit-badge ${isError ? 'cbx-exit-err' : 'cbx-exit-ok'}">` +
      `${escHtml(line)}` +
      `</span>`
    this._scroll.appendChild(article)
    this._scrollBottom()
  }

  // kind: 'add' | 'delete' | 'update' (codex SDK provides path+kind, no line diff).
  // When called from the legacy text path, kind may be a full label string.
  _addPatchBlock(kind, path, status) {
    const KIND_META = {
      add: { cls: 'cbx-patch-add', icon: '+', verb: 'add' },
      delete: { cls: 'cbx-patch-del', icon: '−', verb: 'delete' },
      update: { cls: 'cbx-patch-upd', icon: '✏', verb: 'edit' },
    }
    const meta = KIND_META[kind]
    let cls, icon, label
    if (meta && path != null) {
      cls = meta.cls
      icon = meta.icon
      label = `${meta.verb} ${path}`
    } else {
      // Legacy single-arg call: `kind` is the whole label line.
      cls = 'cbx-patch-upd'
      icon = '✏'
      label = String(kind)
    }
    const failed = status === 'failed'
    const article = this._makeBlock(`cbx-block-patch ${cls}${failed ? ' cbx-patch-failed' : ''}`)
    article.innerHTML =
      `<div class="cbx-patch-header">` +
      `<span class="cbx-patch-icon">${escHtml(icon)}</span>` +
      `<span class="cbx-patch-label"></span>` +
      (failed ? `<span class="cbx-patch-status">failed</span>` : '') +
      `</div>`
    appendRichText(article.querySelector('.cbx-patch-label'), label, { ansi: false })
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
      const body = last.querySelector('.cbx-text-pre')
      if (body) {
        last._cbxTextRaw = (last._cbxTextRaw || body.textContent || '') + '\n' + line
        renderCodexRichMarkdown(body, last._cbxTextRaw)
        this._scrollBottom()
        return
      }
    }

    // Create new text block
    const article = this._makeBlock('cbx-block-text')
    article._cbxTextRaw = line
    const body = document.createElement('div')
    body.className = 'cbx-text-pre cbx-rich-text'
    renderCodexRichMarkdown(body, line)
    article.appendChild(body)
    this._scroll.appendChild(article)
    this._scrollBottom()
  }

  // ── Session info accumulator (codex startup banner) ──────────────────────────

  _accumulateSessionInfo(key, value) {
    if (!this._sessionInfoEl) {
      // Create the session info bar once
      const bar = document.createElement('div')
      bar.className = 'cbx-session-info'
      this._scroll.appendChild(bar)
      this._sessionInfoEl = bar
      this._sessionInfoData = {}
    }
    this._sessionInfoData[key] = value
    // Render compact: model / directory / permissions
    const parts = []
    if (this._sessionInfoData.model) {
      // Trim the "/model to change" hint that codex appends after the model name
      const modelName = this._sessionInfoData.model.replace(/\s*\/model\s+to\s+change.*$/i, '').replace(/\s{2,}/g, ' ').trim()
      parts.push(`<span class="cbx-si-model">${escHtml(modelName)}</span>`)
    }
    if (this._sessionInfoData.directory) {
      const dir = this._sessionInfoData.directory
        .replace(/^\/storage\/home\/[^/]+\//, '~/')
        .replace(/\/storage\/home\/[^/]+\//, '~/')
        .trim()
      parts.push(`<span class="cbx-si-dir">${escHtml(dir)}</span>`)
    }
    if (this._sessionInfoData.permissions) {
      const perm = this._sessionInfoData.permissions.trim()
      parts.push(`<span class="cbx-si-perm">${escHtml(perm)}</span>`)
    }
    this._sessionInfoEl.innerHTML = parts.join('<span class="cbx-si-sep"> · </span>')
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
    const p = document.createElement('p')
    p.className = 'cbx-system'
    appendRichText(p, msg, { ansi: false })
    article.appendChild(p)
    this._scroll.appendChild(article)
    this._scrollBottom()
  }

  _appendUserBlock(text) {
    const article = this._makeBlock('cbx-block-user')
    const p = document.createElement('p')
    p.className = 'cbx-user-prompt'
    p.appendChild(document.createTextNode('❯ '))
    appendRichText(p, text, { ansi: false })
    article.appendChild(p)
    this._scroll.appendChild(article)
    this._scrollBottom()
  }

  _scrollBottom() {
    if (!this._pinToBottom) {
      this._updateScrollBtn()
      return
    }
    requestAnimationFrame(() => {
      this._scroll.scrollTop = this._scroll.scrollHeight
      this._updateScrollBtn()
    })
  }

  // Called by the tab manager when this pane becomes the active/visible tab.
  // History may have replayed while hidden (scrollHeight was 0), so re-pin to
  // the bottom now that the element has real layout.
  onActivated() {
    if (!this._pinToBottom) return
    requestAnimationFrame(() => {
      this._scroll.scrollTop = this._scroll.scrollHeight
      this._updateScrollBtn()
    })
  }
}
