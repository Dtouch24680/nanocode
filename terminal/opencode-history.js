/**
 * OpenCode history service — loads persisted session data and converts it into
 * the same flat event shape the live SDK driver emits, so the frontend can
 * replay past turns into the block renderer.
 *
 * opencode persists sessions in its own database; `opencode export <sessionID>`
 * dumps a session as JSON (info + messages[] with parts[]). We translate each
 * message's parts into {type, ...} events:
 *   text         -> { type:'text', text }
 *   tool         -> { type:'tool_use', tool, state, callID }
 *   step-start   -> { type:'step_start' }
 *   step-finish  -> { type:'step_finish', reason, tokens }
 * Plus we synthesise user_prompt events from user-role messages so the
 * replayed conversation shows the user's original prompts.
 */

import { spawn } from 'node:child_process'

/**
 * Run `opencode export <sessionID>` and return the parsed JSON object.
 * Returns null on any failure (missing session, parse error, timeout).
 *
 * @param {string} home   — unused for now, reserved for future path-based access
 * @param {string} sessionID
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs=8000]
 * @param {string} [opts.bin='opencode']
 */
export function loadOpenCodeSessionExport(home, sessionID, { timeoutMs = 8000, bin = 'opencode' } = {}) {
  if (!sessionID) return null
  return new Promise((resolve) => {
    let proc
    try {
      proc = spawn(bin, ['export', sessionID], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env },
      })
    } catch {
      resolve(null)
      return
    }
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      resolve(result)
    }
    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL') } catch {}
      finish(null)
    }, timeoutMs)

    proc.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8') })
    proc.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8') })
    proc.on('error', () => { clearTimeout(timer); finish(null) })
    proc.on('close', () => {
      clearTimeout(timer)
      // `opencode export` prints a leading "Exporting session: <id>" line before
      // the JSON. Strip everything up to the first '{' so JSON.parse succeeds.
      const jsonStart = stdout.indexOf('{')
      if (jsonStart < 0) return finish(null)
      const jsonText = stdout.slice(jsonStart)
      try {
        finish(JSON.parse(jsonText))
      } catch {
        finish(null)
      }
    })
  })
}

/**
 * Convert an opencode export payload into the flat event list the renderer
 * consumes. Mirrors the unwrapping done in opencode-sdk-driver.js.
 *
 * @param {object} exportData — parsed output of `opencode export <sessionID>`
 * @returns {Array<object>} events
 */
export function exportToEvents(exportData) {
  if (!exportData || !Array.isArray(exportData.messages)) return []
  const events = []
  for (const message of exportData.messages) {
    const role = message?.info?.role
    const parts = Array.isArray(message?.parts) ? message.parts : []
    if (role === 'user') {
      // Synthesise a user_prompt event so the replay shows the user's turn.
      // Concatenate any text parts to form the prompt body.
      let text = ''
      for (const p of parts) {
        if (p?.type === 'text' && typeof p.text === 'string') text += p.text
      }
      if (text) events.push({ type: 'user_prompt', text })
      continue
    }
    // assistant / tool messages: emit each part as its own event.
    for (const p of parts) {
      const type = p?.type
      if (!type) continue
      // Normalise hyphenated part types (step-start, step-finish) to
      // underscored form so the renderer handles one vocabulary across both
      // the live SDK driver path and this export-replay path.
      const normalisedType = type.replace(/-/g, '_')
      events.push({ ...p, type: normalisedType, _replay: true })
    }
  }
  return events
}

/**
 * Load a session's history as renderer events. Convenience wrapper that combines
 * loadOpenCodeSessionExport + exportToEvents.
 *
 * @param {string} home
 * @param {string} sessionID
 * @param {object} [opts]
 * @returns {Promise<Array<object>>}
 */
export async function loadOpenCodeHistoryEvents(home, sessionID, opts) {
  const data = await loadOpenCodeSessionExport(home, sessionID, opts)
  return exportToEvents(data)
}
