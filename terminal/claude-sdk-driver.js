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
        void q.close?.().catch(() => {})
        return
      }
      handle._nanocodeInterrupted = true
      void q.interrupt?.().catch(() => {})
    },
  }
  return handle
}

export function createClaudeSdkDriver({
  store,
  claudeBroadcast,
  rerunTurn,
  runCliFallback,
  queryImpl = defaultQuery,
}) {
  async function runSdkTurn(cs, userText, sessionKey, cwd) {
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
    // ── Three-layer session fallback (SDK path) ─────────────────────────────
    // Layer 1: not first turn → resume
    // Layer 2: first turn with explicitSessionId → also resume
    //          (if SDK throws "not found", runCliFallback handles --continue)
    // Layer 3: truly new session → sessionId
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
          // maxTurns: not set — let SDK use its default (≈25), same as claude --print CLI
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
        // Detect resume-miss errors: SDK throws when --resume session doesn't exist
        const isResumeMiss = (
          text.includes('No conversation found') ||
          text.includes('no conversation') ||
          text.includes('Session not found') ||
          text.includes('session not found') ||
          text.includes('not found')
        ) && (useResumeOnFirstTurn || !isFirstTurn)

        // If we have a CLI fallback, broadcast sdk_error_fallback and retry this turn via CLI.
        // For resume-miss: if sessionFallback=continue, the CLI will use --continue.
        // For other errors: CLI retries the same args (existing behaviour).
        if (typeof runCliFallback === 'function') {
          if (isResumeMiss && sessionFallback !== 'strict') {
            console.warn(`[sdk:resume-miss] ${sessionKey}: SDK resume failed (${text.slice(0, 80)}), falling back to CLI --continue`)
            cs.explicitSessionId = false  // clear so CLI fallback uses --continue path
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
          sawResult = true  // suppress the finally result broadcast
        } else {
          claudeBroadcast(cs, { type: 'system', subtype: 'spawn_error', text })
        }
      }
    } finally {
      // When the CLI fallback is triggered, the CLI takes over cs ownership.
      // Skip the standard finally cleanup to avoid corrupting cs.busy / queue.
      if (_cliFallbackTriggered) {
        // Hand off to CLI: reset cs state for CLI and dispatch
        cs.busy = false
        cs.currentProc = null
        // Decrement turn count so CLI uses the correct session option for this turn
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
      // On interrupt: auto-flush queued messages unless setting disabled.
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

  return { runSdkTurn }
}
