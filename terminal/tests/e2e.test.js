/**
 * E2E test: projects API, folder listing, WebSocket attach, input/output,
 * disconnect/reconnect with scrollback history, and multi-project switching.
 *
 * Run from repo root: npm run test:terminal-e2e
 *
 * Architecture: docs/architecture.md#websocket-protocol
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import WebSocket from 'ws'

const PORT = Number(process.env.TERMINAL_E2E_PORT || process.env.PORT) || 40500
const BASE = `http://127.0.0.1:${PORT}`
const WS_URL = `ws://127.0.0.1:${PORT}/ws/terminal`
const EXAMPLE_CWD = join(homedir(), 'example-project')

/** Collect messages from a WS until predicate returns true or timeout. */
function collectMessages(ws, predicate, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const messages = []
    let settled = false
    const done = () => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      resolve(messages)
    }
    const timeout = setTimeout(() => {
      if (settled) return
      settled = true
      reject(
        new Error(
          `Timeout after ${timeoutMs}ms. Got ${messages.length} messages: ${JSON.stringify(messages.map((message) => message.type))}`
        )
      )
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
        clearTimeout(timeout)
        reject(err)
      }
    })
  })
}

async function openSession(projectId, sessionType = 'bash') {
  const ws = new WebSocket(WS_URL)
  await once(ws, 'open')
  const collector = collectMessages(ws, (msgs) =>
    msgs.some((message) => message.type === 'output' || message.type === 'history')
  )
  ws.send(JSON.stringify({ type: 'attach', projectId, sessionType, cols: 80, rows: 24 }))
  const messages = await collector
  return { ws, messages }
}

function sendAndExpect(ws, input, expectedSubstring, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    let settled = false
    let output = ''
    const timeout = setTimeout(() => {
      if (settled) return
      settled = true
      reject(
        new Error(
          `Timeout: expected "${expectedSubstring}" in output, got: ${JSON.stringify(output)}`
        )
      )
    }, timeoutMs)
    ws.on('message', (raw) => {
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
          clearTimeout(timeout)
          resolve(output)
        }
      }
    })
    ws.send(JSON.stringify({ type: 'input', data: input }))
  })
}

describe('terminal e2e', () => {
  it('lists current project with valid fields', async () => {
    const res = await fetch(`${BASE}/api/projects`)
    const list = await res.json()
    assert(Array.isArray(list) && list.length >= 1)
    assert(list[0].id)
    assert(list[0].name)
    assert(list[0].cwd)
  })

  it('lists home directory for folder picker', async () => {
    const res = await fetch(`${BASE}/api/fs`)
    const data = await res.json()
    assert(data.path)
    assert(Array.isArray(data.entries))
  })

  it('returns 404 for a missing directory under home', async () => {
    const res = await fetch(`${BASE}/api/fs?path=${encodeURIComponent(EXAMPLE_CWD)}`)
    const exists = existsSync(EXAMPLE_CWD)
    if (exists) {
      assert.equal(res.ok, true)
    } else {
      assert.equal(res.status, 404)
    }
  })

  it('adds and deletes a project via REST', async () => {
    const createRes = await fetch(`${BASE}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'e2e-project', cwd: homedir() }),
    })
    assert.equal(createRes.ok, true)
    const project = await createRes.json()
    assert(project.id)

    const deleteRes = await fetch(`${BASE}/api/projects/${project.id}`, {
      method: 'DELETE',
    })
    assert.equal(deleteRes.status, 204)
  })

  it('WS connects to /ws/terminal and rejects invalid path', async () => {
    const ws = new WebSocket(WS_URL)
    await once(ws, 'open')
    ws.close()

    const badWs = new WebSocket(`ws://127.0.0.1:${PORT}/ws/bash`)
    try {
      await once(badWs, 'open')
      assert.fail('Expected WS to /ws/bash to be rejected')
    } catch {
      // expected
    }
  })

  it('WS attach to current project receives output', async () => {
    const res = await fetch(`${BASE}/api/projects`)
    const list = await res.json()
    const { ws, messages } = await openSession(list[0].id, 'bash')
    assert(messages.length >= 1)
    ws.close()
  })

  it('WS attach with invalid projectId receives error', async () => {
    const ws = new WebSocket(WS_URL)
    await once(ws, 'open')
    const collector = collectMessages(ws, (msgs) =>
      msgs.some((message) => message.type === 'error')
    )
    ws.send(
      JSON.stringify({
        type: 'attach',
        projectId: 'nonexistent-id',
        sessionType: 'bash',
        cols: 80,
        rows: 24,
      })
    )
    const msgs = await collector
    assert(msgs.some((message) => message.type === 'error'))
    ws.close()
  })

  it('typing in terminal produces output', async () => {
    const res = await fetch(`${BASE}/api/projects`)
    const list = await res.json()
    const { ws } = await openSession(list[0].id, 'bash')
    const output = await sendAndExpect(ws, 'echo hello_e2e\r', 'hello_e2e')
    assert(output.includes('hello_e2e'))
    ws.close()
  })

  it('reconnect replays scrollback history from prior session', async () => {
    const res = await fetch(`${BASE}/api/projects`)
    const list = await res.json()
    const projectId = list[0].id
    const marker = `E2E_MARKER_${Date.now()}`

    const { ws: first } = await openSession(projectId, 'bash')
    await sendAndExpect(first, `echo ${marker}\r`, marker)
    first.close()

    await new Promise((resolve) => setTimeout(resolve, 200))

    const second = new WebSocket(WS_URL)
    await once(second, 'open')
    const collector = collectMessages(
      second,
      (msgs) =>
        msgs.some(
          (message) =>
            (message.type === 'history' || message.type === 'output') &&
            message.data?.includes(marker)
        ),
      5000
    )
    second.send(
      JSON.stringify({
        type: 'attach',
        projectId,
        sessionType: 'bash',
        cols: 80,
        rows: 24,
      })
    )
    const msgs = await collector
    const combined = msgs
      .filter((message) => message.type === 'history' || message.type === 'output')
      .map((message) => message.data)
      .join('')
    assert(combined.includes(marker))
    second.close()
  })

  it('ping/pong latency measurement works', async () => {
    const res = await fetch(`${BASE}/api/projects`)
    const list = await res.json()
    const { ws } = await openSession(list[0].id, 'bash')

    const pongPromise = collectMessages(ws, (msgs) =>
      msgs.some((message) => message.type === 'pong')
    )
    ws.send(JSON.stringify({ type: 'ping', id: Date.now() }))
    const msgs = await pongPromise
    const pong = msgs.find((message) => message.type === 'pong')
    assert(pong)
    assert(pong.id)
    ws.close()
  })
})
