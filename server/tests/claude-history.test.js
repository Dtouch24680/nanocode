import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseJsonlHistory } from '../../terminal/claude-history.js'

const tempDirs = []

function makeTempDir(prefix) {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop(), { recursive: true, force: true })
  }
})

describe('parseJsonlHistory', () => {
  it('keeps distinct assistant content types while deduplicating progressive rows of the same type', () => {
    const tempDir = makeTempDir('nanocode-claude-history-')
    const jsonlPath = path.join(tempDir, 'session.jsonl')

    writeFileSync(
      jsonlPath,
      [
        JSON.stringify({
          type: 'user',
          uuid: 'user-1',
          message: { role: 'user', content: 'prompt' },
        }),
        JSON.stringify({
          type: 'assistant',
          uuid: 'assistant-text-old',
          requestId: 'req-1',
          message: { role: 'assistant', content: [{ type: 'text', text: 'draft' }] },
        }),
        JSON.stringify({
          type: 'assistant',
          uuid: 'assistant-text-new',
          requestId: 'req-1',
          message: { role: 'assistant', content: [{ type: 'text', text: 'final text' }] },
        }),
        JSON.stringify({
          type: 'assistant',
          uuid: 'assistant-tool',
          requestId: 'req-1',
          message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'pwd' } }] },
        }),
        JSON.stringify({
          type: 'assistant',
          uuid: 'assistant-no-request',
          message: { role: 'assistant', content: [{ type: 'text', text: 'standalone' }] },
        }),
      ].join('\n') + '\n'
    )

    const events = parseJsonlHistory(jsonlPath)

    assert.equal(events.length, 4)
    assert.deepEqual(
      events.map((event) => ({ type: event.type, uuid: event.uuid, firstPart: event.message.content?.[0]?.type || typeof event.message.content })),
      [
        { type: 'user', uuid: 'user-1', firstPart: 'string' },
        { type: 'assistant', uuid: 'assistant-text-new', firstPart: 'text' },
        { type: 'assistant', uuid: 'assistant-tool', firstPart: 'tool_use' },
        { type: 'assistant', uuid: 'assistant-no-request', firstPart: 'text' },
      ]
    )
  })
})
