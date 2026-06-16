import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { chmodSync, mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createStore } from '../store.js'
import { createTerminalRoutes } from '../../terminal/routes.js'

const tempDirs = []

function makeTempDir(prefix) {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function waitUntil(fn, timeoutMs = 3000, label = 'condition') {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now()

    function check() {
      try {
        const value = fn()
        if (value) return resolve(value)
      } catch (err) {
        return reject(err)
      }
      if (Date.now() - startedAt >= timeoutMs) {
        return reject(new Error(`Timed out waiting for ${label}`))
      }
      setTimeout(check, 25)
    }

    check()
  })
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop(), { recursive: true, force: true })
  }
})

class MockWs extends EventEmitter {
  constructor() {
    super()
    this.readyState = 1
    this.sent = []
  }

  send(data) {
    this.sent.push(JSON.parse(data))
  }

  close() {
    this.readyState = 3
    this.emit('close')
  }
}

function emitJson(ws, payload) {
  ws.emit('message', JSON.stringify(payload))
}

describe('codex sdk route', () => {
  it('routes local codex tabs through the sdk bridge behind codex_driver=sdk', async () => {
    const tempRoot = makeTempDir('nanocode-codex-sdk-route-')
    const projectCwd = path.join(tempRoot, 'workspace')
    mkdirSync(projectCwd, { recursive: true })

    const fakeCodexPath = path.join(tempRoot, 'fake-codex')
    writeFileSync(
      fakeCodexPath,
      `#!/usr/bin/env node
let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => { input += chunk })
process.stdin.on('end', () => {
  const prompt = input.trim()
  console.log(JSON.stringify({ type: 'thread.started', thread_id: 'fake-thread-1' }))
  console.log(JSON.stringify({ type: 'item.completed', item: { id: 'msg-1', type: 'agent_message', text: 'reply:' + prompt } }))
  console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } }))
})
`
    )
    chmodSync(fakeCodexPath, 0o755)

    const store = createStore(':memory:')
    const project = store.createProject('Codex SDK Route', projectCwd)
    const tab = store.createTab(project.id, { type: 'codex', label: 'codex sdk' })
    store.setSetting('codex_driver', 'sdk')
    store.setSetting('codex_path_override', fakeCodexPath)

    const { handleTerminalWs } = createTerminalRoutes(store)

    const ws = new MockWs()
    handleTerminalWs(ws)
    emitJson(ws, {
      type: 'attach',
      projectId: project.id,
      sessionType: 'bash',
      tabId: tab.id,
      cols: 120,
      rows: 40,
    })
    emitJson(ws, { type: 'input', data: 'hello from sdk route' })
    emitJson(ws, { type: 'input', data: '\r' })

    // SDK driver renders via structured codex-event messages (not flattened text).
    const isAgentReply = (m) =>
      m.type === 'codex-event' &&
      m.event?.type === 'item.completed' &&
      m.event.item?.type === 'agent_message' &&
      /reply:hello from sdk route/.test(m.event.item.text || '')

    await waitUntil(() => ws.sent.find(isAgentReply), 3000, 'sdk agent_message event')

    const persistedTab = store.getTab(project.id, tab.id)
    assert.equal(persistedTab.codexThreadId, 'fake-thread-1')
    assert.equal(
      ws.sent.some((m) => m.type === 'codex-event' && m.event?.type === 'turn.completed'),
      true
    )

    const wsReplay = new MockWs()
    handleTerminalWs(wsReplay)
    emitJson(wsReplay, {
      type: 'attach',
      projectId: project.id,
      sessionType: 'bash',
      tabId: tab.id,
      cols: 120,
      rows: 40,
    })

    // Replay restores the structured event stream, including the history-only
    // user_prompt event so the prompt survives reconnect.
    await waitUntil(() => wsReplay.sent.find(isAgentReply), 3000, 'agent_message replay')
    assert.equal(
      wsReplay.sent.some((m) =>
        m.type === 'codex-event' &&
        m.event?.type === 'user_prompt' &&
        m.event.text === 'hello from sdk route'),
      true
    )

    ws.close()
    wsReplay.close()
    store.close()
  })
})
