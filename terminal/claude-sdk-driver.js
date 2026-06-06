import { query as defaultQuery } from '@anthropic-ai/claude-agent-sdk'

function mapPermissionMode(raw) {
  if (raw === 'accept-edits') return 'acceptEdits'
  if (raw === 'auto') return 'auto'
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
    const permMode = store.getSetting('claude_permission_mode') || 'bypass'
    const sessionFallback = store.getSetting('claude_session_fallback') || 'continue'
    const sdkPermissionMode = mapPermissionMode(permMode)
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
      finalSubtype = wasInterrupted ? 'interrupted' : 'error'
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
        claudeBroadcast(cs, makeResultEvent(wasInterrupted ? 'interrupted' : finalSubtype, lastSessionId))
      }

      if (!Array.isArray(cs.queue)) cs.queue = []
      if (wasInterrupted) {
        if (cs.queue.length > 0) {
          const discarded = cs.queue.length
          cs.queue = []
          claudeBroadcast(cs, {
            type: 'system',
            subtype: 'info',
            text: `Queue cleared (${discarded} pending message${discarded > 1 ? 's' : ''} discarded after interrupt).`,
          })
        }
      } else if (cs.queue.length > 0) {
        const allQueued = cs.queue.splice(0)
        const combinedText = allQueued.join('\n\n')
        setImmediate(() => rerunTurn(cs, combinedText, sessionKey, cwd))
      }
    }
  }

  return { runSdkTurn }
}
