import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { convertRolloutToEvents, findCodexRolloutPath, loadCodexThreadEvents } from '../../terminal/codex-history.js'

function jsonl(rows) {
  return rows.map((r) => JSON.stringify(r)).join('\n') + '\n'
}

describe('codex history (rollout jsonl)', () => {
  it('converts rollout entries into structured codex events', () => {
    const content = jsonl([
      { type: 'session_meta', payload: { id: 't1' } },
      { type: 'event_msg', payload: { type: 'task_started' } },
      // Injected context user_message must be skipped.
      { type: 'event_msg', payload: { type: 'user_message', message: '<environment_context>cwd=/x</environment_context>' } },
      { type: 'event_msg', payload: { type: 'user_message', message: 'do the thing' } },
      { type: 'response_item', payload: { type: 'reasoning', encrypted_content: 'xxx' } },
      { type: 'event_msg', payload: { type: 'agent_message', message: 'on it' } },
      { type: 'response_item', payload: { type: 'function_call', name: 'exec_command', call_id: 'c1', arguments: JSON.stringify({ cmd: 'ls -la' }) } },
      // write_stdin must not produce a block.
      { type: 'response_item', payload: { type: 'function_call', name: 'write_stdin', call_id: 'c9', arguments: '{}' } },
      { type: 'response_item', payload: { type: 'function_call_output', call_id: 'c1', output: 'Wall time: 0s\nProcess exited with code 0\nOutput:\nfile-a\nfile-b\n' } },
      { type: 'response_item', payload: { type: 'custom_tool_call', name: 'apply_patch', status: 'completed', input: '*** Begin Patch\n*** Update File: src/app.js\n@@\n-old\n+new\n*** Add File: src/new.js\n*** End Patch' } },
      { type: 'event_msg', payload: { type: 'agent_message', message: 'done' } },
      { type: 'event_msg', payload: { type: 'task_complete' } },
    ])

    const events = convertRolloutToEvents(content)

    assert.deepEqual(events, [
      { type: 'user_prompt', text: 'do the thing' },
      { type: 'item.completed', item: { type: 'agent_message', text: 'on it' } },
      { type: 'item.completed', item: { type: 'command_execution', command: 'ls -la', aggregated_output: 'file-a\nfile-b', exit_code: 0 } },
      { type: 'item.completed', item: { type: 'file_change', status: 'completed', changes: [{ kind: 'update', path: 'src/app.js' }, { kind: 'add', path: 'src/new.js' }] } },
      { type: 'item.completed', item: { type: 'agent_message', text: 'done' } },
      { type: 'turn.completed' },
    ])
  })

  it('parses a nonzero exit code', () => {
    const content = jsonl([
      { type: 'response_item', payload: { type: 'function_call', name: 'exec_command', call_id: 'c1', arguments: JSON.stringify({ cmd: 'false' }) } },
      { type: 'response_item', payload: { type: 'function_call_output', call_id: 'c1', output: 'Process exited with code 1\nOutput:\n' } },
    ])
    const events = convertRolloutToEvents(content)
    assert.equal(events.length, 1)
    assert.equal(events[0].item.exit_code, 1)
  })

  it('finds rollout file by threadId and loads it', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'codex-home-'))
    try {
      const day = path.join(root, '.codex', 'sessions', '2026', '06', '16')
      mkdirSync(day, { recursive: true })
      const tid = '019ecc04-4fc5-7260-9b52-f1b04a9203a2'
      const file = path.join(day, `rollout-2026-06-16T00-01-35-${tid}.jsonl`)
      writeFileSync(file, jsonl([
        { type: 'event_msg', payload: { type: 'user_message', message: 'hello' } },
        { type: 'event_msg', payload: { type: 'agent_message', message: 'hi' } },
      ]))
      assert.equal(findCodexRolloutPath(root, tid), file)
      const events = loadCodexThreadEvents(root, tid)
      assert.equal(events.length, 2)
      assert.equal(events[0].text, 'hello')
      assert.equal(loadCodexThreadEvents(root, 'missing-thread').length, 0)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
