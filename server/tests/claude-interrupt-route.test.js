import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createStore } from '../store.js'
import { createTerminalRoutes } from '../../terminal/routes.js'

const tempDirs = []

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
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

function invokeRoute(router, method, url) {
  return new Promise((resolve, reject) => {
    const req = { method, url, body: {}, query: {}, headers: {} }
    const res = {
      statusCode: 200,
      status(code) {
        this.statusCode = code
        return this
      },
      json(payload) {
        resolve({ statusCode: this.statusCode, payload })
      },
      send(payload) {
        resolve({ statusCode: this.statusCode, payload })
      },
      end(payload) {
        resolve({ statusCode: this.statusCode, payload })
      },
    }

    router.handle(req, res, (err) => {
      if (err) reject(err)
      else resolve({ statusCode: res.statusCode, payload: undefined })
    })
  })
}

async function withProcessEnv(envPatch, fn) {
  const prev = new Map()
  for (const [key, value] of Object.entries(envPatch)) {
    prev.set(key, process.env[key])
    process.env[key] = value
  }
  try {
    return await fn()
  } finally {
    for (const [key, value] of prev.entries()) {
      if (value == null) delete process.env[key]
      else process.env[key] = value
    }
  }
}

describe('claude interrupt route', () => {
  it('clears queued messages when the interrupted claude process exits 0', async () => {
    const tempRoot = makeTempDir('nanocode-claude-interrupt-')
    const homeDir = path.join(tempRoot, 'home')
    const binDir = path.join(tempRoot, 'bin')
    const projectCwd = path.join(tempRoot, 'workspace')
    mkdirSync(homeDir, { recursive: true })
    mkdirSync(binDir, { recursive: true })
    mkdirSync(projectCwd, { recursive: true })

    const fakeClaudePath = path.join(binDir, 'claude')
    writeFileSync(
      fakeClaudePath,
      `#!/usr/bin/env bash
msg="\${@: -1}"
echo '{"type":"system","subtype":"init","tools":[],"session_id":"fake-session"}'
if [[ "$msg" == *"SECOND_PAYLOAD"* ]]; then
  sleep 0.1
  exit 0
fi
trap 'exit 0' INT
while true; do
  sleep 1
done
`
    )
    chmodSync(fakeClaudePath, 0o755)

    await withProcessEnv(
      { HOME: homeDir, PATH: `${binDir}:${process.env.PATH || ''}` },
      async () => {
        const store = createStore(':memory:')
        const project = store.createProject('Interrupt Project', projectCwd)
        const tab = store.createTab(project.id, { type: 'claude', label: 'claude interrupt' })
        const { router, handleTerminalWs } = createTerminalRoutes(store)

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

        emitJson(ws, { type: 'claude-input', text: 'FIRST_PAYLOAD', _nonce: 'n1' })
        await delay(100)
        emitJson(ws, { type: 'claude-input', text: 'SECOND_PAYLOAD', _nonce: 'n2' })

        await waitUntil(
          () => ws.sent.find((m) => m.type === 'claude-event' && m.event?.subtype === 'queued'),
          3000,
          'queued system event'
        )

        const interruptRes = await invokeRoute(
          router,
          'POST',
          `/api/projects/${project.id}/tabs/${tab.id}/interrupt`
        )
        assert.equal(interruptRes.statusCode, 200)

        await waitUntil(
          () => ws.sent.find((m) => m.type === 'claude-event' && m.event?.type === 'result'),
          3000,
          'result event'
        )
        // 9840310: auto-flush emits "Resuming with N queued message(s)…" then runs the
        // queued turn. No "Queue cleared" event — that was the old pre-9840310 behavior.
        await waitUntil(
          () => ws.sent.find((m) => m.type === 'claude-event' && m.event?.subtype === 'info' && /Resuming with/.test(m.event.text || '')),
          3000,
          'resuming with queued messages info event'
        )

        // Wait for the auto-flushed SECOND_PAYLOAD turn to also complete
        await waitUntil(
          () => ws.sent.filter((m) => m.type === 'claude-event' && m.event?.type === 'result').length >= 2,
          3000,
          'second result event (auto-flushed turn)'
        )

        await delay(200)

        const resultEvents = ws.sent
          .filter((m) => m.type === 'claude-event' && m.event?.type === 'result')
          .map((m) => m.event)
        // First result: the interrupted turn; second: the auto-flushed SECOND_PAYLOAD turn
        assert.ok(resultEvents.length >= 2, `Expected ≥2 result events, got ${resultEvents.length}`)
        // a33d294: interrupt subtype is 'error_during_execution' (matches CLI stdout output)
        assert.equal(resultEvents[0].subtype, 'error_during_execution')

        store.close()
        ws.close()
      }
    )
  })
})
