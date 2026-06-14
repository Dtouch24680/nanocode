import { query as defaultQuery } from '@anthropic-ai/claude-agent-sdk'

// Resolve the SDK permissionMode from nanocode settings.
//
// The UI persists the three-tier `global_permission` setting (same one the CLI
// driver reads at claude-session-controller.js): full-auto / auto-edits / ask.
// We map each tier to the matching SDK PermissionMode so SDK behaviour is 1:1
// with the CLI:
//   full-auto  → bypassPermissions (CLI: --dangerously-skip-permissions)
//   auto-edits → acceptEdits       (CLI: --permission-mode acceptEdits)
//   ask        → default           (CLI: --permission-mode default)
//
// Legacy `claude_permission_mode` (bypass / accept-edits / auto) is still
// honoured for backward compat if it was ever set, but the UI no longer writes
// it. global_permission takes precedence.
function resolvePermissionMode(store) {
  const globalPerm = store.getSetting('global_permission')
  if (globalPerm === 'auto-edits') return 'acceptEdits'
  if (globalPerm === 'ask') return 'default'
  if (globalPerm === 'full-auto') return 'bypassPermissions'

  // Fallback: legacy claude_permission_mode (kept for old stores).
  const legacy = store.getSetting('claude_permission_mode')
  if (legacy === 'accept-edits') return 'acceptEdits'
  if (legacy === 'auto') return 'auto'
  if (legacy === 'default' || legacy === 'ask') return 'default'

  // Default matches CLI default (global_permission defaults to full-auto).
  return 'bypassPermissions'
}

function makeResultEvent(subtype, sessionId = null) {
  const event = { type: 'result', subtype }
  if (sessionId) event.session_id = sessionId
  return event
}

function createCurrentQueryHandle(q) {
  const handle = {
    _nanocodeInterrupted: false,
    kill(signal = 'SIGINT') {
      if (signal === 'SIGKILL') {
        handle._nanocodeInterrupted = true
        void q.close?.()
        return
      }
      handle._nanocodeInterrupted = true
      void q.interrupt?.().catch(() => {})
    },
  }
  return handle
}

// ── Streaming Session: one persistent query() per claude tab ──────────────────
//
// Instead of spawning a new query() for every user turn, we open a single
// query() in streaming-input mode (AsyncIterable<SDKUserMessage> prompt) at
// session creation time and push messages into it via pushMessage().
//
// Benefits:
//   • MCP servers connect once — no reconnect churn every turn
//   • Cron / ScheduleWakeup / timers started by claude survive across turns
//   • Slightly lower latency (no process startup cost per turn)
//
// Turn boundary: every turn ends with a `SDKResultMessage` (type='result').
// We resolve the per-turn promise when we see that event.
//
// Crash recovery: if the query() generator exits unexpectedly (process crash /
// SDK error), we rebuild it with `{resume: claudeSessionId}` so context is
// preserved. The pending turn promise is rejected, allowing runSdkTurn's error
// handler to call the CLI fallback if needed.

function createMessageStream() {
  const queue = []          // buffered SDKUserMessage objects
  const waiters = []        // pending next() calls
  let closed = false

  function push(msg) {
    if (closed) return
    if (waiters.length > 0) {
      const resolve = waiters.shift()
      resolve({ value: msg, done: false })
    } else {
      queue.push(msg)
    }
  }

  function close() {
    closed = true
    for (const resolve of waiters) {
      resolve({ value: undefined, done: true })
    }
    waiters.length = 0
  }

  const stream = {
    [Symbol.asyncIterator]() {
      return {
        next() {
          if (queue.length > 0) {
            return Promise.resolve({ value: queue.shift(), done: false })
          }
          if (closed) {
            return Promise.resolve({ value: undefined, done: true })
          }
          return new Promise((resolve) => {
            waiters.push(resolve)
          })
        },
      }
    },
  }

  return { push, close, stream }
}

function makeSDKUserMessage(text) {
  return {
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text }] },
    parent_tool_use_id: null,
  }
}

// A StreamingSession wraps one long-lived query() call.
// cs._streamingSession is set when the session is alive; null when torn down.
class StreamingSession {
  constructor({ queryImpl, options, sessionKey, onEvent, onDone }) {
    this._queryImpl = queryImpl
    this._options = options          // SDK query options (cwd, permissionMode, etc.)
    this._sessionKey = sessionKey
    this._onEvent = onEvent          // (event) → void — broadcast to clients
    this._onDone = onDone            // () → void — called when generator exhausts

    this._msgStream = createMessageStream()
    this._closed = false
    this._interrupted = false

    // Per-turn promise control: resolve/reject when the current turn's
    // SDKResultMessage arrives (or when the stream crashes).
    this._turnResolve = null
    this._turnReject = null

    // Start consuming events in the background.
    this._consumePromise = this._startConsume()
  }

  // Build the SDK query options, merging the turn-specific options.
  _buildOptions() {
    return {
      ...this._options,
      // prompt is passed separately as the stream object
    }
  }

  async _startConsume() {
    const q = this._queryImpl({
      prompt: this._msgStream.stream,
      options: this._buildOptions(),
    })

    // Store interrupt/close handles on the query object itself.
    this._q = q
    this._handle = createCurrentQueryHandle(q)

    try {
      for await (const event of q) {
        if (this._closed) break
        this._onEvent(event)

        // Resolve the pending turn promise when we see a result event.
        if (event?.type === 'result') {
          const resolve = this._turnResolve
          this._turnResolve = null
          this._turnReject = null
          if (resolve) resolve({ event, interrupted: false })
        }
      }
    } catch (err) {
      // Generator threw — reject the pending turn if any.
      const reject = this._turnReject
      this._turnResolve = null
      this._turnReject = null
      if (reject) reject(err)
      else {
        // No pending turn — just log; the session will be torn down.
        console.warn(`[sdk:streaming] ${this._sessionKey}: unhandled stream error: ${err?.message}`)
      }
    } finally {
      this._closed = true
      this._onDone()
    }
  }

  // Push a user message into the stream and wait for the result event.
  // Returns a Promise that resolves with { event, interrupted } when the
  // result arrives, or rejects on error.
  sendAndWait(text) {
    return new Promise((resolve, reject) => {
      this._turnResolve = resolve
      this._turnReject = reject
      this._msgStream.push(makeSDKUserMessage(text))
    })
  }

  // Interrupt the current turn (soft).
  interrupt() {
    this._interrupted = true
    return this._handle?.kill('SIGINT')
  }

  // Force-close the stream (hard kill).
  close() {
    this._closed = true
    this._msgStream.close()
    this._handle?.kill('SIGKILL')
  }

  get isAlive() {
    return !this._closed
  }

  // Expose the handle so cs.currentProc can call .kill()
  get handle() {
    return this._handle
  }
}

export function createClaudeSdkDriver({
  store,
  claudeBroadcast,
  rerunTurn,
  runCliFallback,
  queryImpl = defaultQuery,
}) {
  // Whether to use streaming mode (single persistent query per session).
  // Falls back to per-turn mode when queryImpl is overridden (test mocks).
  const useStreamingMode = queryImpl === defaultQuery

  // ── Per-turn mode (tests / legacy) ─────────────────────────────────────────
  // Kept exactly as before so existing tests pass without modification.

  async function runPerTurnSdkTurn(cs, userText, sessionKey, cwd) {
    if (cs.busy) {
      if (!Array.isArray(cs.queue)) cs.queue = []
      cs.queue.push(userText)
      claudeBroadcast(cs, {
        type: 'system',
        subtype: 'queued',
        text: `Message queued (position ${cs.queue.length}). Will run after current turn.`,
      })
      return
    }

    cs.busy = true
    cs.currentProc = null

    const isFirstTurn = cs.turnCount === 0
    cs.turnCount += 1

    const claudeModel = store.getSetting('claude_model') || ''
    const claudeEffort = store.getSetting('claude_effort') || ''
    const sessionFallback = store.getSetting('claude_session_fallback') || 'continue'
    const sdkPermissionMode = resolvePermissionMode(store)
    const useResumeOnFirstTurn = !isFirstTurn || cs.explicitSessionId
    const sessionOptions = useResumeOnFirstTurn
      ? { resume: cs.claudeSessionId }
      : { sessionId: cs.claudeSessionId }

    let sawResult = false
    let sawInit = false
    let lastSessionId = cs.claudeSessionId
    let finalSubtype = 'success'
    let _cliFallbackTriggered = false

    try {
      const q = queryImpl({
        prompt: userText,
        options: {
          cwd,
          includePartialMessages: true,
          forwardSubagentText: true,
          model: claudeModel || undefined,
          effort: claudeEffort || undefined,
          permissionMode: sdkPermissionMode,
          allowDangerouslySkipPermissions: sdkPermissionMode === 'bypassPermissions',
          stderr: (text) => {
            const trimmed = typeof text === 'string' ? text.trim() : ''
            if (!trimmed) return
            claudeBroadcast(cs, { type: 'system', subtype: 'stderr', text: trimmed })
          },
          ...sessionOptions,
        },
      })

      const currentQuery = createCurrentQueryHandle(q)
      cs.currentProc = currentQuery

      for await (const event of q) {
        if (event?.session_id) lastSessionId = event.session_id
        if (event?.type === 'system' && event?.subtype === 'init' && event?.session_id) {
          sawInit = true
          if (event.session_id !== cs.claudeSessionId) {
            cs.claudeSessionId = event.session_id
            const [projectId, , tabId] = sessionKey.split(':')
            store.updateTabMetadata?.(projectId, tabId, { claudeSessionId: event.session_id })
          }
        }
        if (event?.type === 'result') {
          sawResult = true
          finalSubtype = event.subtype || finalSubtype
        }
        claudeBroadcast(cs, event)
      }
    } catch (err) {
      const wasInterrupted = cs.currentProc?._nanocodeInterrupted === true
      finalSubtype = wasInterrupted ? 'error_during_execution' : 'error'
      const text = err?.message || String(err)
      if (!wasInterrupted) {
        const isResumeMiss = (
          text.includes('No conversation found') ||
          text.includes('no conversation') ||
          text.includes('Session not found') ||
          text.includes('session not found') ||
          text.includes('not found')
        ) && (useResumeOnFirstTurn || !isFirstTurn)

        const isSdkWrappedResultError = text.startsWith('Claude Code returned an error result:')

        if (isSdkWrappedResultError && !isResumeMiss) {
          console.warn(`[sdk:result-error] ${sessionKey}: SDK wrapped error result (${text.slice(0, 120)}), suppressing CLI fallback`)
          if (!sawResult) {
            const reason = text.slice('Claude Code returned an error result: '.length).trim()
            claudeBroadcast(cs, {
              type: 'result',
              subtype: 'error_during_execution',
              is_error: true,
              duration_ms: 0,
              duration_api_ms: 0,
              num_turns: cs.turnCount,
              total_cost_usd: 0,
              result: reason || text,
              session_id: lastSessionId,
              errors: [reason || text],
            })
            sawResult = true
          }
        } else if (typeof runCliFallback === 'function') {
          if (isResumeMiss && sessionFallback !== 'strict') {
            console.warn(`[sdk:resume-miss] ${sessionKey}: SDK resume failed (${text.slice(0, 80)}), falling back to CLI --continue`)
            cs.explicitSessionId = false
            claudeBroadcast(cs, {
              type: 'system',
              subtype: 'continue_fallback',
              text: `[Session not found — falling back to --continue to pick up most recent context]`,
            })
          } else {
            const reason = text.length > 120 ? text.slice(0, 120) + '…' : text
            claudeBroadcast(cs, {
              type: 'system',
              subtype: 'sdk_error_fallback',
              text: `SDK error: ${reason}，已自动切回 CLI 这一 turn`,
            })
          }
          _cliFallbackTriggered = true
          sawResult = true
        } else {
          claudeBroadcast(cs, { type: 'system', subtype: 'spawn_error', text })
        }
      }
    } finally {
      if (_cliFallbackTriggered) {
        cs.busy = false
        cs.currentProc = null
        cs.turnCount -= 1
        setImmediate(() => runCliFallback(cs, userText, sessionKey, cwd))
        return
      }

      const wasInterrupted = cs.currentProc?._nanocodeInterrupted === true
      cs.busy = false
      cs.currentProc = null

      if (!sawInit && lastSessionId && lastSessionId !== cs.claudeSessionId) {
        cs.claudeSessionId = lastSessionId
      }

      if (!sawResult) {
        claudeBroadcast(cs, makeResultEvent(wasInterrupted ? 'error_during_execution' : finalSubtype, lastSessionId))
      }

      if (!Array.isArray(cs.queue)) cs.queue = []
      const autoFlushOnInterrupt = store.getSetting('auto_flush_queue_on_interrupt') !== '0'
      if (cs.queue.length > 0) {
        if (!wasInterrupted || autoFlushOnInterrupt) {
          const allQueued = cs.queue.splice(0)
          const combinedText = allQueued.join('\n\n')
          if (wasInterrupted) {
            claudeBroadcast(cs, { type: 'system', subtype: 'info', text: `Resuming with ${allQueued.length} queued message${allQueued.length !== 1 ? 's' : ''}…` })
          }
          setImmediate(() => rerunTurn(cs, combinedText, sessionKey, cwd))
        }
      }
    }
  }

  // ── Streaming mode (production) ─────────────────────────────────────────────
  // One persistent query() per session tab. Messages are pushed into the stream;
  // result events mark the end of each turn.

  function buildStreamingOptions(cs, cwd) {
    const claudeModel = store.getSetting('claude_model') || ''
    const claudeEffort = store.getSetting('claude_effort') || ''
    const sdkPermissionMode = resolvePermissionMode(store)
    const isFirstTurn = cs.turnCount === 0
    const useResumeOnFirstTurn = !isFirstTurn || cs.explicitSessionId
    const sessionOptions = useResumeOnFirstTurn
      ? { resume: cs.claudeSessionId }
      : { sessionId: cs.claudeSessionId }
    return {
      cwd,
      includePartialMessages: true,
      forwardSubagentText: true,
      model: claudeModel || undefined,
      effort: claudeEffort || undefined,
      permissionMode: sdkPermissionMode,
      allowDangerouslySkipPermissions: sdkPermissionMode === 'bypassPermissions',
      stderr: (text) => {
        const trimmed = typeof text === 'string' ? text.trim() : ''
        if (!trimmed) return
        claudeBroadcast(cs, { type: 'system', subtype: 'stderr', text: trimmed })
      },
      ...sessionOptions,
    }
  }

  function teardownStreamingSession(cs) {
    if (cs._streamingSession) {
      try { cs._streamingSession.close() } catch {}
      cs._streamingSession = null
    }
  }

  // Create (or rebuild after crash) the streaming session for cs.
  function ensureStreamingSession(cs, sessionKey, cwd) {
    if (cs._streamingSession?.isAlive) return cs._streamingSession

    // Tear down any dead session.
    teardownStreamingSession(cs)

    const options = buildStreamingOptions(cs, cwd)
    const ss = new StreamingSession({
      queryImpl: defaultQuery,
      options,
      sessionKey,
      onEvent: (event) => {
        // Track session_id from any event.
        if (event?.session_id && event.session_id !== cs.claudeSessionId) {
          cs.claudeSessionId = event.session_id
          const [projectId, , tabId] = sessionKey.split(':')
          store.updateTabMetadata?.(projectId, tabId, { claudeSessionId: event.session_id })
        }
        // Broadcast to all clients (the waiting turn also picks up events
        // via the claudeBroadcast mechanism).
        claudeBroadcast(cs, event)
      },
      onDone: () => {
        // Generator exhausted — clear the session reference.
        if (cs._streamingSession === ss) {
          cs._streamingSession = null
        }
        console.log(`[sdk:streaming] ${sessionKey}: query generator exhausted`)
      },
    })

    cs._streamingSession = ss
    console.log(`[sdk:streaming] ${sessionKey}: started new streaming session (sessionId=${cs.claudeSessionId})`)
    return ss
  }

  async function runStreamingSdkTurn(cs, userText, sessionKey, cwd) {
    if (cs.busy) {
      if (!Array.isArray(cs.queue)) cs.queue = []
      cs.queue.push(userText)
      claudeBroadcast(cs, {
        type: 'system',
        subtype: 'queued',
        text: `Message queued (position ${cs.queue.length}). Will run after current turn.`,
      })
      return
    }

    cs.busy = true
    cs.currentProc = null

    const isFirstTurn = cs.turnCount === 0
    cs.turnCount += 1

    const sessionFallback = store.getSetting('claude_session_fallback') || 'continue'
    const useResumeOnFirstTurn = !isFirstTurn || cs.explicitSessionId

    let sawResult = false
    let finalSubtype = 'success'
    let _cliFallbackTriggered = false

    // Collect broadcast events for this turn (to detect sawResult etc.)
    // We hook into the onEvent path by tracking result events here.
    let _turnResultEvent = null
    const _origBroadcast = claudeBroadcast

    // We need to intercept result events emitted during this turn.
    // Since onEvent in ensureStreamingSession calls claudeBroadcast directly,
    // we track turn result in a flag set by the sendAndWait resolution.

    try {
      const ss = ensureStreamingSession(cs, sessionKey, cwd)

      // Set cs.currentProc so interrupt() from routes.js can kill the turn.
      cs.currentProc = {
        _nanocodeInterrupted: false,
        kill(signal = 'SIGINT') {
          this._nanocodeInterrupted = true
          if (signal === 'SIGKILL') {
            ss.close()
            // Tear down streaming session on hard kill.
            cs._streamingSession = null
          } else {
            ss.interrupt()
          }
        },
      }

      // sendAndWait pushes the message and waits for the result event.
      // The result event is already broadcast by onEvent above.
      const { event: resultEvent } = await ss.sendAndWait(userText)
      sawResult = true
      finalSubtype = resultEvent?.subtype || 'success'
      _turnResultEvent = resultEvent

    } catch (err) {
      const wasInterrupted = cs.currentProc?._nanocodeInterrupted === true
      finalSubtype = wasInterrupted ? 'error_during_execution' : 'error'
      const text = err?.message || String(err)

      if (!wasInterrupted) {
        const isResumeMiss = (
          text.includes('No conversation found') ||
          text.includes('no conversation') ||
          text.includes('Session not found') ||
          text.includes('session not found') ||
          text.includes('not found')
        ) && (useResumeOnFirstTurn || !isFirstTurn)

        const isSdkWrappedResultError = text.startsWith('Claude Code returned an error result:')

        if (isSdkWrappedResultError && !isResumeMiss) {
          console.warn(`[sdk:streaming:result-error] ${sessionKey}: SDK wrapped error result (${text.slice(0, 120)}), suppressing CLI fallback`)
          if (!sawResult) {
            const reason = text.slice('Claude Code returned an error result: '.length).trim()
            claudeBroadcast(cs, {
              type: 'result',
              subtype: 'error_during_execution',
              is_error: true,
              duration_ms: 0,
              duration_api_ms: 0,
              num_turns: cs.turnCount,
              total_cost_usd: 0,
              result: reason || text,
              session_id: cs.claudeSessionId,
              errors: [reason || text],
            })
            sawResult = true
          }
          // Tear down the streaming session so next turn rebuilds fresh.
          teardownStreamingSession(cs)
        } else if (typeof runCliFallback === 'function') {
          if (isResumeMiss && sessionFallback !== 'strict') {
            console.warn(`[sdk:streaming:resume-miss] ${sessionKey}: streaming session resume failed (${text.slice(0, 80)}), falling back to CLI --continue`)
            cs.explicitSessionId = false
            claudeBroadcast(cs, {
              type: 'system',
              subtype: 'continue_fallback',
              text: `[Session not found — falling back to --continue to pick up most recent context]`,
            })
          } else {
            const reason = text.length > 120 ? text.slice(0, 120) + '…' : text
            claudeBroadcast(cs, {
              type: 'system',
              subtype: 'sdk_error_fallback',
              text: `SDK error: ${reason}，已自动切回 CLI 这一 turn`,
            })
          }
          // Tear down streaming session — CLI takes over.
          teardownStreamingSession(cs)
          _cliFallbackTriggered = true
          sawResult = true
        } else {
          claudeBroadcast(cs, { type: 'system', subtype: 'spawn_error', text })
          teardownStreamingSession(cs)
        }
      } else {
        // Interrupted — don't tear down the session (it may still be usable).
        // If the session is now dead, it'll be rebuilt on next turn.
      }
    } finally {
      if (_cliFallbackTriggered) {
        cs.busy = false
        cs.currentProc = null
        cs.turnCount -= 1
        setImmediate(() => runCliFallback(cs, userText, sessionKey, cwd))
        return
      }

      const wasInterrupted = cs.currentProc?._nanocodeInterrupted === true
      cs.busy = false
      cs.currentProc = null

      if (!sawResult) {
        claudeBroadcast(cs, makeResultEvent(wasInterrupted ? 'error_during_execution' : finalSubtype, cs.claudeSessionId))
      }

      if (!Array.isArray(cs.queue)) cs.queue = []
      const autoFlushOnInterrupt = store.getSetting('auto_flush_queue_on_interrupt') !== '0'
      if (cs.queue.length > 0) {
        if (!wasInterrupted || autoFlushOnInterrupt) {
          const allQueued = cs.queue.splice(0)
          const combinedText = allQueued.join('\n\n')
          if (wasInterrupted) {
            claudeBroadcast(cs, { type: 'system', subtype: 'info', text: `Resuming with ${allQueued.length} queued message${allQueued.length !== 1 ? 's' : ''}…` })
          }
          setImmediate(() => rerunTurn(cs, combinedText, sessionKey, cwd))
        }
      }
    }
  }

  // Public API: route to streaming or per-turn based on whether a custom queryImpl was injected.
  function runSdkTurn(cs, userText, sessionKey, cwd) {
    if (useStreamingMode) {
      return runStreamingSdkTurn(cs, userText, sessionKey, cwd)
    }
    return runPerTurnSdkTurn(cs, userText, sessionKey, cwd)
  }

  return { runSdkTurn }
}
