/**
 * OpenCodeBlockRenderer — DOM block renderer for OpenCode CLI tabs.
 *
 * Mirrors ClaudeBlockRenderer's contract but consumes the opencode event
 * stream (`opencode run --format json`):
 *   step_start  — a model step begins (turn is active)
 *   text        — assistant text (streamed; may arrive in one shot)
 *   tool_use    — a tool call with {tool, state:{status,input,output,...}}
 *   step_finish — step ended (reason: stop | tool-calls)
 *   user_prompt — (replay-only) user's original prompt text
 *   notice / stderr / error / turn.completed / clear — synthetic events
 *
 * Public API (matches TerminalPane / ClaudeBlockRenderer):
 *   new OpenCodeBlockRenderer(container, { projectId, tabId, onStatusChange })
 *   .sendInputWithEcho(text)
 *   .sendRaw(data)
 *   .clearAfterReset()
 *   .showInterruptBlock()
 *   .dispose()
 *   .isThinking()
 *   .onActivated()
 *   .fitAddon
 *
 * WS protocol (to server): {type:'attach', projectId, sessionType:'bash', tabId, cols, rows}
 *                         {type:'input', data:'...'}     — user text + '\r'
 *                         {type:'ping', id}
 * WS protocol (from server):
 *   {type:'opencode-event', event}  — one structured event (live or replay)
 *   {type:'opencode-replay-start'}  — bulk replay begins
 *   {type:'opencode-replay-end'}    — bulk replay ends
 *   {type:'exit'|'error'|'pong'}
 */

import {
  createSystemBlock,
  createTextBlock,
  createToolUseBlock,
  buildToolResultHtml,
} from './claude-block-renderer/dom-render.js'
import {
  BaseBlockRenderer,
  escHtml,
  renderMarkdown,
  renderCode,
  attachCopyHandlers,
  attachPathAndUrlHandlers,
  BACKOFF_BASE,
  BACKOFF_MAX,
} from './claude-block-renderer/base-renderer.js'
import { getToolFoldLevel, applyToolFold, cycleToolFold } from './claude-block-renderer/fold-state.js'

// opencode tool name -> icon SVG (subset of claude's set; opencode uses
// lowercase tool names: read, write, edit, bash, grep, glob, list, etc.)
const OPENCODE_TOOL_ICONS = {
  bash:    `<svg class="cbr-tool-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="18" rx="2"/><polyline points="8 10 12 14 16 10"/><line x1="8" y1="14" x2="16" y2="14"/></svg>`,
  read:    `<svg class="cbr-tool-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>`,
  edit:    `<svg class="cbr-tool-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>`,
  write:   `<svg class="cbr-tool-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>`,
  grep:    `<svg class="cbr-tool-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/></svg>`,
  glob:    `<svg class="cbr-tool-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="2" x2="12" y2="22"/><line x1="2" y1="12" x2="22" y2="12"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/><line x1="19.07" y1="4.93" x2="4.93" y2="19.07"/></svg>`,
  list:    `<svg class="cbr-tool-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>`,
  webfetch:  `<svg class="cbr-tool-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>`,
  websearch: `<svg class="cbr-tool-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>`,
  task:    `<svg class="cbr-tool-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="10" rx="2"/><circle cx="12" cy="5" r="2"/><path d="M12 7v4"/></svg>`,
  agent:   `<svg class="cbr-tool-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="10" rx="2"/><circle cx="12" cy="5" r="2"/><path d="M12 7v4"/></svg>`,
}

function getToolIcon(toolName) {
  if (!toolName) return ''
  return OPENCODE_TOOL_ICONS[String(toolName).toLowerCase()] || ''
}

/**
 * Build a one-line subhint for an opencode tool call (file path / command).
 * opencode tool inputs use camelCase keys (filePath, content, command, pattern).
 */
function buildToolSubhint(part, escHtmlFn) {
  const inp = part?.state?.input || part?.input || {}
  const name = (part?.tool || '').toLowerCase()
  let raw = ''
  if (name === 'bash' || name === 'exec') {
    raw = (typeof inp.command === 'string') ? inp.command.slice(0, 120) : ''
  } else if (name === 'edit' || name === 'write' || name === 'multiedit') {
    const fp = inp.filePath || inp.path || inp.file_path || ''
    if (fp) raw = fp.replace(/^\/storage\/home\/[^/]+\//, '~/').replace(/^\/home\/[^/]+\//, '~/')
  } else if (name === 'read') {
    const fp = inp.filePath || inp.path || inp.file_path || ''
    if (fp) {
      raw = fp.replace(/^\/storage\/home\/[^/]+\//, '~/').replace(/^\/home\/[^/]+\//, '~/')
      if (inp.offset != null || inp.limit != null) {
        const parts = []
        if (inp.offset != null) parts.push(`L${inp.offset}`)
        if (inp.limit != null) parts.push(`+${inp.limit}`)
        raw += `:${parts.join('-')}`
      }
    }
  } else if (name === 'glob') {
    raw = inp.pattern || ''
  } else if (name === 'grep') {
    raw = inp.pattern || ''
    if (inp.path) raw += ` in ${inp.path}`
    raw = raw.slice(0, 100)
  } else if (name === 'list') {
    raw = inp.path || ''
  } else if (name === 'webfetch') {
    raw = (inp.url || '').slice(0, 100)
  } else if (name === 'websearch') {
    raw = (inp.query || '').slice(0, 100)
  } else if (name === 'task' || name === 'agent') {
    raw = (inp.description || inp.prompt || '').slice(0, 100)
  } else {
    if (typeof inp.description === 'string') raw = inp.description.slice(0, 100)
    if (!raw) {
      for (const v of Object.values(inp)) {
        if (typeof v === 'string' && v.trim()) { raw = v.slice(0, 100); break }
      }
    }
  }
  if (!raw.trim()) return ''
  return escHtmlFn(raw)
}

// ── Main class ────────────────────────────────────────────────────────────────

export class OpenCodeBlockRenderer extends BaseBlockRenderer {
  constructor(container, opts = {}) {
    super(container, {
      ...opts,
      containerClass: 'cbr-container oc-container',
      scrollClass: 'cbr-scroll oc-scroll',
      thinkingEventName: 'nanocode:opencode-thinking',
    })

    // Live assistant text block being streamed (updated in place as text arrives)
    this._liveTextBlock = null
    this._liveTextBuffer = ''
    this._liveMessageId = null

    // "Thinking…" indicator block shown between step_start and the first
    // text/tool event. OpenCode's CLI emits the full text only when the model
    // step completes, so without this the user sees nothing for seconds at a
    // time and can't tell if the turn is still running or has hung.
    this._thinkingEl = null

    // Pending tool_use blocks keyed by callID (so we can attach results later)
    this._pendingToolBlocks = new Map()

    // Track the "Connection lost" block for in-place update
    this._connLostEl = null

    // Pending nonces for user-prompt dedup (set on send, cleared on echo)
    this._pendingNonces = new Set()

    // Connect immediately
    this._connect()
  }

  // ── Public API ───────────────────────────────────────────────────────────────

  sendInputWithEcho(text) {
    this._userScrolledUp = false
    this._appendUserBlock(text)
    this._send({ type: 'input', data: text })
    setTimeout(() => this._send({ type: 'input', data: '\r' }), 50)
    // Clear any live assistant block so the next response starts fresh
    this._liveTextBlock = null
    this._liveTextBuffer = ''
    this._liveMessageId = null
    this._setThinking(true)
    // Show the thinking indicator immediately — step_start may take a moment
    // to arrive from the opencode CLI, and without this the user sees no
    // feedback that their message was received and is being processed.
    this._showThinkingIndicator()
  }

  sendRaw(data) {
    if (data === '\x03') {
      // Interrupt: POST the interrupt API endpoint (real SIGINT to the opencode process)
      if (this.projectId && this.tabId) {
        fetch(`/api/projects/${this.projectId}/tabs/${this.tabId}/interrupt`, { method: 'POST' })
          .catch(() => {})
      }
    }
    if (data === '\x0c') {
      // Ctrl+L: visually clear the scroll area
      this._scroll.innerHTML = ''
    }
  }

  clearAfterReset() {
    this._scroll.innerHTML = ''
    this._liveTextBlock = null
    this._liveTextBuffer = ''
    this._liveMessageId = null
    this._pendingToolBlocks.clear()
    this._pendingNonces = new Set()
    this._setThinking(false)
    this._addSystemBlock('[Session reset. Starting fresh.]')
  }

  showInterruptBlock() {
    const article = createSystemBlock('[Request interrupted by user]', { escHtml })
    article.className += ' cbr-block-interrupted'
    article.querySelector('.cbr-system')?.classList?.add('cbr-interrupted')
    this._scroll.appendChild(article)
    this._scrollBottom()
  }

  // ── WS lifecycle (subclass hooks) ───────────────────────────────────────────

  _onWsOpen(_isReconnect) {
    // OpenCode uses WS-replay (like codex), not an HTTP history endpoint.
    // Just send attach — the server replays cs.eventHistory immediately.
    this._send({
      type: 'attach',
      projectId: this.projectId,
      sessionType: 'bash',
      tabId: this.tabId,
      cols: 200,
      rows: 50,
    })
  }

  _onWsMessage(msg) {
    if (msg.type === 'opencode-replay-start') {
      this._replayMode = true
      return
    }
    if (msg.type === 'opencode-replay-end') {
      this._replayMode = false
      this._scrollBottom({ force: true })
      return
    }
    if (msg.type === 'opencode-event') {
      if (msg.event) this._handleEvent(msg.event)
      return
    }
  }

  _onWsExit(msg) {
    // Base class already adds the exit system block; nothing extra needed.
    void msg
  }

  _onWsDisconnect(delay) {
    const msg = `[Connection lost. Reconnecting in ${(delay / 1000).toFixed(1)}s…]`
    if (this._connLostEl) {
      const p = this._connLostEl.querySelector('p.cbr-system')
      if (p) p.textContent = msg
    } else {
      this._connLostEl = this._addSystemBlock(msg)
    }
  }

  _onDispose() {
    this._hideThinkingIndicator()
    this._pendingToolBlocks.clear()
  }

  // ── Event handling ──────────────────────────────────────────────────────────

  _isLiveTurnEvent(event) {
    if (!event || !event.type) return false
    switch (event.type) {
      case 'step_start':
      case 'text':
      case 'tool':
      case 'tool_use':
        return true
      case 'step_finish':
        return false // ends the step, not a progress signal
      default:
        return false
    }
  }

  _handleEvent(event) {
    if (!event || !event.type) return

    // Clear the "Connection lost" block on first real event after reconnect
    if (this._connLostEl) {
      this._connLostEl.remove()
      this._connLostEl = null
    }

    // Thinking-state derivation: any live turn-progress event marks us busy.
    // step_finish with reason 'stop' (or turn.completed) ends the turn.
    if (!event._replay && !this._exited && this._isLiveTurnEvent(event)) {
      this._setThinking(true)
    }

    switch (event.type) {
      case 'step_start':
        this._handleStepStart(event)
        break
      case 'text':
        this._handleText(event)
        break
      case 'tool':
      case 'tool_use':
        this._handleToolUse(event)
        break
      case 'step_finish':
        this._handleStepFinish(event)
        break
      case 'user_prompt':
        // Replay-only: the user's original prompt. Avoid double-render if this
        // client sent it (sendInputWithEcho already added a user block).
        this._handleUserPrompt(event)
        break
      case 'notice':
        this._addSystemBlock(event.text || '')
        break
      case 'stderr':
        this._addSystemBlock(`[stderr: ${event.text || ''}]`)
        break
      case 'error':
        this._addSystemBlock(`[Error: ${event.message || event.text || 'unknown error'}]`)
        break
      case 'turn.completed':
        this._handleTurnCompleted(event)
        break
      case 'clear':
        this._scroll.innerHTML = ''
        this._liveTextBlock = null
        this._liveTextBuffer = ''
        this._liveMessageId = null
        this._thinkingEl = null
        this._pendingToolBlocks.clear()
        break
      default:
        // Unknown event type — ignore silently
        break
    }
  }

  _handleStepStart(event) {
    // A new model step begins. If we have a live text block from a previous
    // step, finalise it (stop streaming updates).
    if (this._liveTextBlock) {
      this._liveTextBlock.classList.remove('cbr-live')
      this._liveTextBlock = null
      this._liveTextBuffer = ''
      this._liveMessageId = null
    }
    // Remember the messageID so text events can be associated.
    if (event.messageID) this._liveMessageId = event.messageID
    // Show a "thinking" indicator — OpenCode doesn't stream partial text,
    // so without this the user sees nothing while the model is working.
    // Skip during replay (past events being re-rendered, not a live turn).
    if (!event._replay) this._showThinkingIndicator()
  }

  _showThinkingIndicator() {
    // Don't double-create if already showing
    if (this._thinkingEl) return
    const el = document.createElement('div')
    el.className = 'oc-thinking-indicator'
    el.innerHTML =
      `<span class="oc-thinking-dots">` +
      `<span class="oc-thinking-dot"></span>` +
      `<span class="oc-thinking-dot"></span>` +
      `<span class="oc-thinking-dot"></span>` +
      `</span>` +
      `<span class="oc-thinking-label">思考中…</span>`
    this._scroll.appendChild(el)
    this._thinkingEl = el
    this._scrollBottom()
  }

  _hideThinkingIndicator() {
    if (this._thinkingEl) {
      this._thinkingEl.remove()
      this._thinkingEl = null
    }
  }

  _handleText(event) {
    const text = event.text || ''
    if (!text) return

    // Text arrived — the model has finished thinking for this step.
    this._hideThinkingIndicator()

    // If this text belongs to a new message (or no live block yet), start one.
    const sameMessage = event.messageID && this._liveMessageId === event.messageID
    if (!this._liveTextBlock || !sameMessage) {
      // Finalise any previous live block
      if (this._liveTextBlock) this._liveTextBlock.classList.remove('cbr-live')
      this._liveTextBlock = createTextBlock(text, {
        live: true,
        renderMarkdown,
        escHtml,
        attachCopyHandlers,
        attachPathAndUrlHandlers,
      })
      this._scroll.appendChild(this._liveTextBlock)
      this._liveTextBuffer = text
      this._liveMessageId = event.messageID || null
    } else {
      // Append to the existing live block (streaming). opencode typically sends
      // the full text in one event, but handle incremental updates just in case.
      this._liveTextBuffer += text
      const html = renderMarkdown(this._liveTextBuffer, { streaming: true })
      const body = this._liveTextBlock.querySelector('.cbr-text')
      if (body) body.innerHTML = html
    }
    this._scrollBottom()
  }

  _handleToolUse(event) {
    const toolName = event.tool || 'tool'
    const state = event.state || {}
    const status = state.status || 'running'
    const input = state.input || {}
    const output = state.output
    const callID = event.callID

    // A tool call means the model finished thinking for this step.
    this._hideThinkingIndicator()

    // Build a tool-use block. opencode carries the result inline in state, so
    // when status is completed/error we render input + output together.
    const isLoading = status === 'running' || status === 'pending'

    // Normalise the part shape for dom-render.js (expects part.name + part.input)
    const part = {
      name: toolName,
      tool: toolName,
      input,
    }

    // Render input as a code block when it's non-trivial
    let inputHtml = ''
    if (input && Object.keys(input).length > 0) {
      const inputStr = typeof input === 'string' ? input : JSON.stringify(input, null, 2)
      if (inputStr.trim()) {
        inputHtml = renderCode(inputStr, 'json')
      }
    }

    const subhint = buildToolSubhint(event, escHtml)

    const article = createToolUseBlock({
      part,
      inputHtml,
      toolIcon: getToolIcon(toolName),
      isLoading,
      isSubagentTool: false,
      isSubagentPrompt: false,
      isSubagentActivity: false,
      activityVisible: true,
      getSubagentPromptVisible: () => true,
      applyToolFold,
      getToolFoldLevel,
      cycleToolFold,
      attachCopyHandlers,
      escHtml,
    })

    // Append the subhint we computed (opencode-specific fields) if the dom-render
    // helper didn't already add one for this tool name.
    if (subhint) {
      const inner = article.querySelector('.cbr-tool-subhint--inner')
      if (inner) inner.innerHTML = subhint
      const outer = article.querySelector('.cbr-tool-subhint--line')
      if (outer) outer.innerHTML = subhint
    }

    this._scroll.appendChild(article)

    // If the result is already present (completed/error), attach it immediately.
    if (!isLoading && output != null) {
      this._attachToolResult(article, output, status === 'error')
    }

    // Track pending blocks so a late result update can find them
    if (callID) {
      if (isLoading) {
        this._pendingToolBlocks.set(callID, article)
      } else {
        this._pendingToolBlocks.delete(callID)
      }
    }

    this._scrollBottom()
  }

  _attachToolResult(article, output, isError) {
    const outputEl = article.querySelector('.cbr-tool-output')
    if (!outputEl) return
    // Normalise opencode's output shape into a result HTML block.
    const fakePart = {
      content: typeof output === 'string' ? output : (output?.text || output?.output || (output == null ? '' : JSON.stringify(output, null, 2))),
      is_error: isError,
    }
    const { resultHtml } = buildToolResultHtml(fakePart, { escHtml })
    outputEl.innerHTML = resultHtml
    attachCopyHandlers(article)
  }

  _handleStepFinish(event) {
    // Finalise any live text block
    this._hideThinkingIndicator()
    if (this._liveTextBlock) {
      this._liveTextBlock.classList.remove('cbr-live')
      // Re-render non-streaming to fix any unclosed fences
      const body = this._liveTextBlock.querySelector('.cbr-text')
      if (body && this._liveTextBuffer) {
        body.innerHTML = renderMarkdown(this._liveTextBuffer, { streaming: false })
        attachCopyHandlers(this._liveTextBlock)
        attachPathAndUrlHandlers(this._liveTextBlock)
      }
      this._liveTextBlock = null
      this._liveTextBuffer = ''
      this._liveMessageId = null
    }

    // reason 'stop' = the model finished answering -> turn ends
    // reason 'tool-calls' = the model called a tool and will continue -> turn stays busy
    if (event.reason === 'stop') {
      this._setThinking(false)
    }
    // 'tool-calls' keeps thinking=true; the next step_start will follow
  }

  _handleTurnCompleted(_event) {
    // Synthetic turn-completed from the driver (e.g. after interrupt cleanup)
    this._hideThinkingIndicator()
    if (this._liveTextBlock) {
      this._liveTextBlock.classList.remove('cbr-live')
      this._liveTextBlock = null
      this._liveTextBuffer = ''
      this._liveMessageId = null
    }
    this._setThinking(false)
  }

  _handleUserPrompt(event) {
    // During replay, user_prompt events restore the user's original message.
    // sendInputWithEcho() already added a user block for live sends, so only
    // render during replay.
    if (!event._replay) return
    this._appendUserBlock(event.text || '')
  }
}
