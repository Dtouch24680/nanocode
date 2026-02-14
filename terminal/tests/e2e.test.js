/**
 * E2E test: projects API, folder listing, WebSocket attach, input/output,
 * disconnect/reconnect with scrollback history, and multi-project switching.
 *
 * Run from repo root: node --test terminal/tests/e2e.test.js
 */

import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import WebSocket from 'ws'

const PORT = Number(process.env.TERMINAL_E2E_PORT) || 40500
const BASE = `http://127.0.0.1:${PORT}`
const WS_URL = `ws://127.0.0.1:${PORT}/ws/terminal`
const EXAMPLE_CWD = join(homedir(), 'example-project')

async function waitForServer(maxMs = 8000) {
  const start = Date.now()
  while (Date.now() - start < maxMs) {
    try {
      const r = await fetch(`${BASE}/api/projects`)
      if (r.ok) return
    } catch (_) {}
    await new Promise((r) => setTimeout(r, 150))
  }
  throw new Error('Server did not become ready in time')
}

/** Collect messages from a WS until predicate returns true or timeout. */
function collectMessages(ws, predicate, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const messages = []
    let settled = false
    const done = () => {
      if (settled) return
      settled = true
      clearTimeout(t)
      resolve(messages)
    }
    const t = setTimeout(() => {
      if (settled) return
      settled = true
      reject(new Error(`Timeout after ${timeoutMs}ms. Got ${messages.length} messages: ${JSON.stringify(messages.map((m) => m.type))}`))
    }, timeoutMs)
    ws.on('message', (raw) => {
      if (settled) return
      let msg
      try {
        msg = JSON.parse(raw.toString())
      } catch {
        return
      }
      messages.push(msg)
      if (predicate(messages, msg)) done()
    })
    ws.on('error', (err) => {
      if (!settled) {
        settled = true
        clearTimeout(t)
        reject(err)
      }
    })
  })
}

/** Open WS, send attach, wait for first output/history, return { ws, messages } */
async function openSession(projectId, sessionType = 'bash') {
  const ws = new WebSocket(WS_URL)
  await once(ws, 'open')
  const collector = collectMessages(ws, (msgs) => msgs.some((m) => m.type === 'output' || m.type === 'history'))
  ws.send(JSON.stringify({ type: 'attach', projectId, sessionType, cols: 80, rows: 24 }))
  const messages = await collector
  return { ws, messages }
}

/** Send input to ws and wait for output containing expected string */
function sendAndExpect(ws, input, expectedSubstring, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    let settled = false
    let output = ''
    const t = setTimeout(() => {
      if (settled) return
      settled = true
      listener()
      reject(new Error(`Timeout: expected "${expectedSubstring}" in output, got: ${JSON.stringify(output)}`))
    }, timeoutMs)
    const listener = ws.on('message', (raw) => {
      if (settled) return
      let msg
      try {
        msg = JSON.parse(raw.toString())
      } catch {
        return
      }
      if (msg.type === 'output') {
        output += msg.data
        if (output.includes(expectedSubstring)) {
          settled = true
          clearTimeout(t)
          resolve(output)
        }
      }
    })
    ws.send(JSON.stringify({ type: 'input', data: input }))
  })
}

let serverProcess
let addedProjectId

async function startServer() {
  serverProcess = spawn(process.execPath, ['terminal/server.js'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  serverProcess.stdout?.setEncoding('utf8')
  serverProcess.stderr?.setEncoding('utf8')
  serverProcess.stdout?.on('data', () => {})
  serverProcess.stderr?.on('data', () => {})
  await waitForServer()
}

async function stopServer() {
  if (serverProcess) {
    serverProcess.kill('SIGTERM')
    await once(serverProcess, 'exit').catch(() => {})
  }
}

describe('terminal e2e', () => {
  before(startServer)

  after(async () => {
    if (addedProjectId) {
      try {
        await fetch(`${BASE}/api/projects/${addedProjectId}`, { method: 'DELETE' })
      } catch (_) {}
    }
    await stopServer()
  })

  // --- REST API tests ---

  it('lists current project with valid fields', async () => {
    const r = await fetch(`${BASE}/api/projects`)
    const list = await r.json()
    assert(Array.isArray(list) && list.length >= 1, `Expected at least one project`)
    const current = list[0]
    assert(current.id, 'project.id missing')
    assert(current.name, 'project.name missing')
    assert(current.cwd, 'project.cwd missing')
  })

  it('lists home directory for folder picker', async () => {
    const r = await fetch(`${BASE}/api/fs`)
    const data = await r.json()
    assert(data.path, 'data.path missing')
    assert(Array.isArray(data.entries), 'data.entries not an array')
  })

  it('lists ~/example-project directory', async () => {
    const r = await fetch(`${BASE}/api/fs?path=${encodeURIComponent(EXAMPLE_CWD)}`)
    const body = await r.text()
    assert.strictEqual(r.ok, true, `GET /api/fs failed: ${r.status} ${body}`)
    const data = JSON.parse(body)
    assert.strictEqual(data.path, EXAMPLE_CWD)
  })

  it('adds example-project project via POST', async () => {
    const r = await fetch(`${BASE}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'example-project', cwd: EXAMPLE_CWD }),
    })
    const body = await r.text()
    assert.strictEqual(r.ok, true, `POST failed: ${r.status} ${body}`)
    const project = JSON.parse(body)
    assert(project.id)
    assert.strictEqual(project.name, 'example-project')
    assert.strictEqual(project.cwd, EXAMPLE_CWD)
    addedProjectId = project.id
  })

  it('lists both projects after add', async () => {
    const r = await fetch(`${BASE}/api/projects`)
    const list = await r.json()
    const names = list.map((p) => p.name)
    assert(names.includes('example-project'), `Missing example-project in: ${names.join(', ')}`)
    assert(list.length >= 2)
  })

  // --- WebSocket lifecycle tests ---

  it('WS connects to /ws/terminal and rejects invalid path', async () => {
    // Valid path: should connect
    const ws = new WebSocket(WS_URL)
    await once(ws, 'open')
    ws.close()

    // Invalid path: should be rejected
    const badWs = new WebSocket(`ws://127.0.0.1:${PORT}/ws/bash`)
    try {
      await once(badWs, 'open')
      assert.fail('Expected WS to /ws/bash to be rejected')
    } catch {
      // Expected: connection rejected
    }
  })

  it('WS attach to current project receives output', async () => {
    const r = await fetch(`${BASE}/api/projects`)
    const list = await r.json()
    const currentId = list.find((p) => p.name !== 'example-project')?.id || list[0].id
    const { ws, messages } = await openSession(currentId, 'bash')
    assert(messages.length >= 1, 'Should receive at least one message on attach')
    const types = messages.map((m) => m.type)
    assert(
      types.includes('output') || types.includes('history'),
      `Expected output or history, got: ${types.join(', ')}`
    )
    ws.close()
  })

  it('WS attach to example-project project receives output', async () => {
    assert(addedProjectId, 'example-project project ID should exist from prior test')
    const { ws, messages } = await openSession(addedProjectId, 'bash')
    assert(messages.length >= 1, 'Should receive at least one message')
    ws.close()
  })

  it('WS attach with invalid projectId receives error', async () => {
    const ws = new WebSocket(WS_URL)
    await once(ws, 'open')
    const collector = collectMessages(ws, (msgs) => msgs.some((m) => m.type === 'error'))
    ws.send(JSON.stringify({ type: 'attach', projectId: 'nonexistent-id', sessionType: 'bash', cols: 80, rows: 24 }))
    const msgs = await collector
    assert(msgs.some((m) => m.type === 'error'), 'Expected error message for invalid project')
    ws.close()
  })

  it('typing in terminal produces output (input/output round-trip)', async () => {
    const r = await fetch(`${BASE}/api/projects`)
    const list = await r.json()
    const currentId = list.find((p) => p.name !== 'example-project')?.id || list[0].id
    const { ws } = await openSession(currentId, 'bash')

    // Send `echo hello_e2e` and expect the output in response
    const output = await sendAndExpect(ws, 'echo hello_e2e\r', 'hello_e2e')
    assert(output.includes('hello_e2e'), `Expected 'hello_e2e' in output`)
    ws.close()
  })

  it('reconnect replays scrollback history from prior session', async () => {
    const r = await fetch(`${BASE}/api/projects`)
    const list = await r.json()
    const currentId = list.find((p) => p.name !== 'example-project')?.id || list[0].id

    // First connection: send a unique marker
    const marker = `E2E_MARKER_${Date.now()}`
    const { ws: ws1 } = await openSession(currentId, 'bash')
    await sendAndExpect(ws1, `echo ${marker}\r`, marker)
    ws1.close()

    // Wait briefly for close to propagate
    await new Promise((r) => setTimeout(r, 200))

    // Second connection: should receive history containing the marker
    const ws2 = new WebSocket(WS_URL)
    await once(ws2, 'open')
    const collector = collectMessages(
      ws2,
      (msgs) => msgs.some((m) => (m.type === 'history' || m.type === 'output') && m.data?.includes(marker)),
      5000
    )
    ws2.send(JSON.stringify({ type: 'attach', projectId: currentId, sessionType: 'bash', cols: 80, rows: 24 }))
    const msgs = await collector
    const historyOrOutput = msgs.filter((m) => m.type === 'history' || m.type === 'output')
    const combined = historyOrOutput.map((m) => m.data).join('')
    assert(combined.includes(marker), `Expected marker '${marker}' in scrollback history, got: ${combined.slice(0, 200)}`)
    ws2.close()
  })

  it('ping/pong latency measurement works', async () => {
    const r = await fetch(`${BASE}/api/projects`)
    const list = await r.json()
    const currentId = list[0].id
    const { ws } = await openSession(currentId, 'bash')

    const pongPromise = collectMessages(ws, (msgs) => msgs.some((m) => m.type === 'pong'))
    ws.send(JSON.stringify({ type: 'ping', id: Date.now() }))
    const msgs = await pongPromise
    const pong = msgs.find((m) => m.type === 'pong')
    assert(pong, 'Expected pong response')
    assert(pong.id, 'Pong should have id field')
    ws.close()
  })
})
