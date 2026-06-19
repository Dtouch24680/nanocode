/**
 * OpenCode SDK driver — bridges the `opencode run --format json` CLI to the
 * nanocode block-renderer pipeline.
 *
 * Each user turn spawns a fresh `opencode run --format json` child process
 * (with `-s <sessionID>` to continue an existing session). The newline-
 * delimited JSON event stream is parsed and re-broadcast to all attached
 * WS clients as `{type:'opencode-event', event}` — mirroring the claude /
 * codex SDK driver contract.
 *
 * Event normalisation:
 *   The raw opencode events use {type, part:{...}} envelopes. We unwrap the
 *   `part` payload and broadcast it directly so the frontend renderer works
 *   with a single, flat event shape:
 *     step_start  -> { type:'step_start',  messageID, sessionID, ... }
 *     text        -> { type:'text',        text, messageID, ... }
 *     tool_use    -> { type:'tool_use',    tool, state, callID, ... }
 *     step_finish -> { type:'step_finish', reason, tokens, ... }
 *
 * Public API:
 *   createOpenCodeSdkDriver({ opencodeBroadcastEvent })
 *     -> { runOpenCodeTurn(cs, prompt, sessionKey, cwd) }
 */

import { spawn } from 'node:child_process'

function createCurrentTurnHandle(proc) {
  const handle = {
    _nanocodeInterrupted: false,
    kill(signal = 'SIGINT') {
      handle._nanocodeInterrupted = true
      if (!proc || proc.exitCode !== null) return
      try {
        // SIGINT lets opencode clean up gracefully; SIGKILL is a hard kill.
        process.kill(proc.pid, signal === 'SIGKILL' ? 'SIGKILL' : 'SIGINT')
      } catch {}
    },
  }
  return handle
}

export function createOpenCodeSdkDriver({
  store,
  opencodeBroadcastEvent,
  rerunTurn,
  opencodeBin = 'opencode',
}) {
  const notice = (cs, text) => opencodeBroadcastEvent(cs, { type: 'notice', text })
  const endTurn = (cs) => opencodeBroadcastEvent(cs, { type: 'turn.completed' })

  /**
   * Spawn an `opencode run` turn and stream its JSON events.
   *
   * @param {object} cs            — session state object
   * @param {string} prompt        — user text
   * @param {string} sessionKey    — `${projectId}:opencode:${tabId}`
   * @param {string} cwd           — working directory
   */
  async function runOpenCodeTurn(cs, prompt, sessionKey, cwd) {
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

    // Persist the user prompt for reconnect replay, but do NOT broadcast live:
    // the frontend already echoes it optimistically via sendInputWithEcho().
    opencodeBroadcastEvent(cs, { type: 'user_prompt', text: trimmedPrompt }, { historyOnly: true })

    const opencodeModel = store.getSetting('opencode_model') || ''
    const opencodeAgent = store.getSetting('opencode_agent') || ''

    const args = ['run', '--format', 'json', '--dangerously-skip-permissions']
    // Continue an existing session when we already have one. The first turn
    // starts a new session (no -s flag) and captures the sessionID from events.
    if (cs.opencodeSessionId) {
      args.push('-s', cs.opencodeSessionId)
    }
    if (opencodeModel) args.push('-m', opencodeModel)
    if (opencodeAgent) args.push('--agent', opencodeAgent)
    args.push('--', trimmedPrompt)

    console.log(`[opencode:spawn] sessionKey=${sessionKey} cwd=${cwd} args=${args.join(' ')}`)
    let proc
    try {
      proc = spawn(opencodeBin, args, {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env },
        detached: false,
      })
    } catch (err) {
      opencodeBroadcastEvent(cs, { type: 'error', message: `Failed to spawn opencode: ${err?.message || err}` })
      endTurn(cs)
      cs.busy = false
      return
    }

    const currentTurn = createCurrentTurnHandle(proc)
    cs.currentProc = currentTurn

    let sawTerminalEvent = false
    let lineBuffer = ''

    proc.stdout.on('data', (chunk) => {
      lineBuffer += chunk.toString('utf8')
      const lines = lineBuffer.split('\n')
      lineBuffer = lines.pop() || ''
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue
        let raw
        try {
          raw = JSON.parse(trimmed)
        } catch {
          continue
        }
        // Capture the sessionID from the first event that carries it.
        // opencode emits sessionID on every event, so we grab it once.
        if (raw?.sessionID && raw.sessionID !== cs.opencodeSessionId) {
          cs.opencodeSessionId = raw.sessionID
          const [projectId, , tabId] = sessionKey.split(':')
          store.updateTabMetadata?.(projectId, tabId, { opencodeSessionId: raw.sessionID })
        }
        // Unwrap the `part` envelope into a flat event the renderer consumes.
        // opencode uses hyphenated part types (step-start, step-finish, tool)
        // while the envelope uses underscores (step_start, step_finish, tool_use).
        // We normalise part.type to underscored form so the renderer handles a
        // single, consistent event vocabulary (matches the export replay path
        // which also normalises via opencode-history.js).
        const part = raw?.part
        let event
        if (part) {
          const normalisedType = typeof part.type === 'string'
            ? part.type.replace(/-/g, '_')
            : part.type
          event = { ...part, type: normalisedType, sessionID: raw.sessionID || part?.sessionID }
        } else {
          event = { type: raw?.type, sessionID: raw?.sessionID }
        }
        opencodeBroadcastEvent(cs, event)

        if (event.type === 'step_finish' && event.reason === 'stop') {
          sawTerminalEvent = true
        }
      }
    })

    proc.stderr.on('data', (chunk) => {
      const text = chunk.toString('utf8').trim()
      if (!text) return
      // Surface non-fatal stderr as a notice so the user sees warnings/errors.
      opencodeBroadcastEvent(cs, { type: 'stderr', text })
    })

    proc.on('error', (err) => {
      opencodeBroadcastEvent(cs, { type: 'error', message: `opencode process error: ${err?.message || err}` })
    })

    proc.on('close', (code, signal) => {
      // Flush any trailing partial line in the buffer
      if (lineBuffer.trim()) {
        try {
          const raw = JSON.parse(lineBuffer.trim())
          const part = raw?.part
          if (part) opencodeBroadcastEvent(cs, part)
        } catch {}
        lineBuffer = ''
      }

      const wasInterrupted = currentTurn._nanocodeInterrupted
      cs.busy = false
      cs.currentProc = null

      if (wasInterrupted) {
        notice(cs, '[Request interrupted by user]')
        // Drop the queue on interrupt to match codex behaviour.
        if (Array.isArray(cs.queue) && cs.queue.length > 0) {
          const discarded = cs.queue.length
          cs.queue = []
          notice(cs, `Queue cleared (${discarded} pending message${discarded > 1 ? 's' : ''} discarded after interrupt).`)
        }
        if (!sawTerminalEvent) endTurn(cs)
        return
      }

      if (code !== 0 && code !== null) {
        opencodeBroadcastEvent(cs, { type: 'error', message: `opencode exited with code ${code}` })
      }
      if (!sawTerminalEvent) endTurn(cs)

      // Auto-run the next queued message, if any.
      if (!Array.isArray(cs.queue)) cs.queue = []
      if (cs.queue.length > 0) {
        const nextPrompt = cs.queue.shift()
        setImmediate(() => rerunTurn(cs, nextPrompt, sessionKey, cwd))
      }
    })
  }

  return { runOpenCodeTurn }
}
