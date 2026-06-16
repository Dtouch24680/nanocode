import { Codex as DefaultCodex } from '@openai/codex-sdk'

function createCurrentTurnHandle(abortController) {
  const handle = {
    _nanocodeInterrupted: false,
    kill(signal = 'SIGINT') {
      handle._nanocodeInterrupted = true
      abortController.abort(new Error(signal === 'SIGKILL' ? 'force killed' : 'interrupted'))
    },
  }
  return handle
}

export function createCodexSdkDriver({
  store,
  codexBroadcast,
  codexBroadcastEvent,
  rerunTurn,
  CodexImpl = DefaultCodex,
}) {
  // Synthetic events (not emitted by the SDK) the frontend renderer understands.
  // These travel on the same codex-event channel so they persist + replay like
  // real events. `historyOnly` suppresses the live send (used for the user prompt,
  // which the frontend already shows optimistically on send).
  const notice = (cs, text) => codexBroadcastEvent(cs, { type: 'notice', text })
  const endTurn = (cs) => codexBroadcastEvent(cs, { type: 'turn.completed' })

  async function runCodexTurn(cs, prompt, sessionKey, cwd) {
    const trimmedPrompt = typeof prompt === 'string' ? prompt.trim() : ''
    if (!trimmedPrompt) return

    if (cs.busy) {
      if (!Array.isArray(cs.queue)) cs.queue = []
      cs.queue.push(trimmedPrompt)
      notice(cs, `Message queued (position ${cs.queue.length}). Will run after current turn.`)
      return
    }

    cs.busy = true
    cs.currentProc = null
    cs.turnCount = (cs.turnCount || 0) + 1

    const codexModel = store.getSetting('codex_model') || ''
    const codexEffort = store.getSetting('codex_effort') || ''
    const sandboxMode = store.getSetting('codex_sandbox_mode') || 'danger-full-access'
    const pathOverride = store.getSetting('codex_path_override') || ''

    const codexOptions = {}
    if (pathOverride) codexOptions.codexPathOverride = pathOverride

    const threadOptions = {
      workingDirectory: cwd,
      skipGitRepoCheck: true,
      approvalPolicy: 'never',
      sandboxMode,
      networkAccessEnabled: true,
    }
    if (codexModel) threadOptions.model = codexModel
    if (codexEffort) threadOptions.modelReasoningEffort = codexEffort

    const client = new CodexImpl(codexOptions)
    const thread = cs.codexThreadId
      ? client.resumeThread(cs.codexThreadId, threadOptions)
      : client.startThread(threadOptions)

    const abortController = new AbortController()
    const currentTurn = createCurrentTurnHandle(abortController)
    cs.currentProc = currentTurn

    // Persist the user prompt for reconnect replay, but do NOT send it live: the
    // frontend already shows it optimistically via sendInputWithEcho().
    codexBroadcastEvent(cs, { type: 'user_prompt', text: trimmedPrompt }, { historyOnly: true })

    let sawTerminalEvent = false
    let lastThreadId = cs.codexThreadId || null

    try {
      const { events } = await thread.runStreamed(trimmedPrompt, { signal: abortController.signal })

      for await (const event of events) {
        codexBroadcastEvent(cs, event)

        if (event.type === 'thread.started' && event.thread_id) {
          lastThreadId = event.thread_id
          if (event.thread_id !== cs.codexThreadId) {
            cs.codexThreadId = event.thread_id
            const [projectId, , tabId] = sessionKey.split(':')
            store.updateTabMetadata?.(projectId, tabId, { codexThreadId: event.thread_id })
          }
        }

        if (event.type === 'turn.completed' || event.type === 'turn.failed' || event.type === 'error') {
          sawTerminalEvent = true
        }
      }
    } catch (err) {
      const wasInterrupted = cs.currentProc?._nanocodeInterrupted === true || err?.name === 'AbortError'
      if (wasInterrupted) {
        notice(cs, '[Request interrupted by user]')
      } else {
        codexBroadcastEvent(cs, { type: 'error', message: err?.message || String(err) })
      }
      endTurn(cs)
      sawTerminalEvent = true
    } finally {
      cs.busy = false
      cs.currentProc = null

      if (!cs.codexThreadId && lastThreadId) {
        cs.codexThreadId = lastThreadId
      }

      if (!Array.isArray(cs.queue)) cs.queue = []
      if (currentTurn._nanocodeInterrupted) {
        if (cs.queue.length > 0) {
          const discarded = cs.queue.length
          cs.queue = []
          notice(cs, `Queue cleared (${discarded} pending message${discarded > 1 ? 's' : ''} discarded after interrupt).`)
        }
      } else if (cs.queue.length > 0) {
        const nextPrompt = cs.queue.shift()
        setImmediate(() => rerunTurn(cs, nextPrompt, sessionKey, cwd))
      } else if (!sawTerminalEvent) {
        endTurn(cs)
      }
    }
  }

  return { runCodexTurn }
}
