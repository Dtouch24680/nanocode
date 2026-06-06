import { Codex as DefaultCodex } from '@openai/codex-sdk'

const TURN_SEPARATOR = '────────────\n'

function ensureTrailingNewline(text) {
  if (!text) return ''
  return text.endsWith('\n') ? text : `${text}\n`
}

function formatFileChanges(changes = []) {
  if (!Array.isArray(changes) || changes.length === 0) return ''
  const lines = changes.map((change) => `patch: ${change.kind || 'update'} ${change.path || ''}`.trimEnd())
  return ensureTrailingNewline(lines.join('\n'))
}

function formatCodexEventAsOutput(event) {
  if (!event || !event.type) return ''

  if (event.type === 'item.started') {
    if (event.item?.type === 'command_execution' && event.item.command) {
      return ensureTrailingNewline(`Running: ${event.item.command}`)
    }
    if (event.item?.type === 'file_change') {
      return formatFileChanges(event.item.changes)
    }
    return ''
  }

  if (event.type === 'item.completed') {
    if (event.item?.type === 'agent_message') {
      return ensureTrailingNewline(event.item.text || '')
    }
    if (event.item?.type === 'command_execution') {
      let text = ''
      if (event.item.aggregated_output) text += ensureTrailingNewline(event.item.aggregated_output)
      if (event.item.exit_code != null && event.item.exit_code !== 0) {
        text += ensureTrailingNewline(`exit ${event.item.exit_code}`)
      }
      return text
    }
    if (event.item?.type === 'file_change') {
      return formatFileChanges(event.item.changes)
    }
    return ''
  }

  if (event.type === 'turn.completed') {
    return TURN_SEPARATOR
  }

  if (event.type === 'turn.failed') {
    return `[Error: ${event.error?.message || 'Codex turn failed'}]\n${TURN_SEPARATOR}`
  }

  if (event.type === 'error') {
    return `[Error: ${event.message || 'Codex stream error'}]\n${TURN_SEPARATOR}`
  }

  return ''
}

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
  async function runCodexTurn(cs, prompt, sessionKey, cwd) {
    const trimmedPrompt = typeof prompt === 'string' ? prompt.trim() : ''
    if (!trimmedPrompt) return

    if (cs.busy) {
      if (!Array.isArray(cs.queue)) cs.queue = []
      cs.queue.push(trimmedPrompt)
      codexBroadcast(cs, `[queued: Message queued (position ${cs.queue.length}). Will run after current turn.]\n`)
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

    codexBroadcast(cs, `› ${trimmedPrompt}\n`)

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

        const text = formatCodexEventAsOutput(event)
        if (text) codexBroadcast(cs, text)
        if (event.type === 'turn.completed' || event.type === 'turn.failed' || event.type === 'error') {
          sawTerminalEvent = true
        }
      }
    } catch (err) {
      const wasInterrupted = cs.currentProc?._nanocodeInterrupted === true || err?.name === 'AbortError'
      if (wasInterrupted) {
        codexBroadcast(cs, '[Request interrupted by user]\n')
        codexBroadcast(cs, TURN_SEPARATOR)
      } else {
        codexBroadcast(cs, `[Error: ${err?.message || String(err)}]\n`)
        codexBroadcast(cs, TURN_SEPARATOR)
      }
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
          codexBroadcast(cs, `[Queue cleared (${discarded} pending message${discarded > 1 ? 's' : ''} discarded after interrupt).]\n`)
        }
      } else if (cs.queue.length > 0) {
        const nextPrompt = cs.queue.shift()
        setImmediate(() => rerunTurn(cs, nextPrompt, sessionKey, cwd))
      } else if (!sawTerminalEvent) {
        codexBroadcast(cs, TURN_SEPARATOR)
      }
    }
  }

  return { runCodexTurn }
}
