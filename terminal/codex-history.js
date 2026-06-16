import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

// Codex persists every thread as a "rollout" jsonl under
//   ~/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<threadId>.jsonl
// This is the authoritative, durable history for a thread (survives both a
// browser refresh and a server restart). We locate the file by threadId and
// convert it into the same structured codex-event objects the frontend renders,
// mirroring how claude rebuilds a session from its jsonl.

const MAX_EVENTS = 600

function codexSessionsRoot(home) {
  return join(home, '.codex', 'sessions')
}

// Recursively find the rollout file whose name ends with `-<threadId>.jsonl`.
// Sessions are date-partitioned, so we walk newest-first and stop on first hit.
export function findCodexRolloutPath(home, threadId) {
  if (!home || !threadId) return null
  const root = codexSessionsRoot(home)
  if (!existsSync(root)) return null
  const suffix = `-${threadId}.jsonl`

  function walk(dir) {
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return null }
    // Descend directories newest-first (lexical sort works for zero-padded dates).
    const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort().reverse()
    const files = entries.filter((e) => e.isFile()).map((e) => e.name)
    for (const name of files) {
      if (name.endsWith(suffix)) return join(dir, name)
    }
    for (const d of dirs) {
      const found = walk(join(dir, d))
      if (found) return found
    }
    return null
  }
  return walk(root)
}

function parseExecArguments(args) {
  try {
    const obj = typeof args === 'string' ? JSON.parse(args) : args
    const cmd = obj?.cmd
    if (Array.isArray(cmd)) return cmd.join(' ')
    return typeof cmd === 'string' ? cmd : ''
  } catch { return '' }
}

// codex exec output is wrapped with bookkeeping lines; extract the real output
// and the exit code.
function parseExecOutput(raw) {
  const text = typeof raw === 'string' ? raw : (raw?.output ?? '')
  const codeMatch = text.match(/exited with code (\d+)/)
  const exitCode = codeMatch ? Number(codeMatch[1]) : 0
  const marker = text.indexOf('Output:\n')
  const output = marker >= 0 ? text.slice(marker + 'Output:\n'.length) : text
  return { output: output.replace(/\s+$/, ''), exitCode }
}

// Parse an apply_patch payload into {kind, path} changes.
function parsePatchChanges(input) {
  const changes = []
  if (typeof input !== 'string') return changes
  const re = /\*\*\*\s+(Add|Update|Delete) File:\s+(.+)/g
  let m
  while ((m = re.exec(input)) !== null) {
    const kind = m[1].toLowerCase() === 'add' ? 'add' : m[1].toLowerCase() === 'delete' ? 'delete' : 'update'
    changes.push({ kind, path: m[2].trim() })
  }
  return changes
}

// Injected context messages we should not show as user prompts.
function isInjectedContext(text) {
  if (typeof text !== 'string') return true
  const t = text.trimStart()
  return t.startsWith('<environment_context>') ||
    t.startsWith('<permissions') ||
    t.startsWith('<user_instructions>')
}

export function convertRolloutToEvents(content) {
  const events = []
  const pendingExec = new Map() // call_id -> command string

  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let row
    try { row = JSON.parse(trimmed) } catch { continue }
    const p = row.payload
    if (!p) continue

    if (row.type === 'event_msg') {
      if (p.type === 'user_message' && !isInjectedContext(p.message)) {
        events.push({ type: 'user_prompt', text: p.message || '' })
      } else if (p.type === 'agent_message') {
        events.push({ type: 'item.completed', item: { type: 'agent_message', text: p.message || '' } })
      } else if (p.type === 'task_complete') {
        events.push({ type: 'turn.completed' })
      }
      continue
    }

    if (row.type === 'response_item') {
      if (p.type === 'function_call' && p.name === 'exec_command') {
        const cmd = parseExecArguments(p.arguments)
        if (p.call_id) pendingExec.set(p.call_id, cmd)
      } else if (p.type === 'function_call_output') {
        const cmd = pendingExec.get(p.call_id) || ''
        pendingExec.delete(p.call_id)
        if (cmd) {
          const { output, exitCode } = parseExecOutput(p.output)
          events.push({
            type: 'item.completed',
            item: { type: 'command_execution', command: cmd, aggregated_output: output, exit_code: exitCode },
          })
        }
      } else if (p.type === 'custom_tool_call' && p.name === 'apply_patch') {
        const changes = parsePatchChanges(p.input)
        if (changes.length) {
          events.push({
            type: 'item.completed',
            item: { type: 'file_change', status: p.status === 'failed' ? 'failed' : 'completed', changes },
          })
        }
      }
    }
  }

  // Keep the conversation bounded; if we trim, tell the user up front.
  if (events.length > MAX_EVENTS) {
    const dropped = events.length - MAX_EVENTS
    const kept = events.slice(-MAX_EVENTS)
    kept.unshift({ type: 'notice', text: `[Earlier history truncated — ${dropped} older events hidden]` })
    return kept
  }
  return events
}

// Load and convert a thread's full rollout history. Returns [] if unavailable.
export function loadCodexThreadEvents(home, threadId) {
  const path = findCodexRolloutPath(home, threadId)
  if (!path) return []
  try {
    const st = statSync(path)
    if (!st.isFile()) return []
    return convertRolloutToEvents(readFileSync(path, 'utf8'))
  } catch { return [] }
}
