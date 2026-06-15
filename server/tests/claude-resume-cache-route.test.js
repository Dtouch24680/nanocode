import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createStore } from '../store.js'
import { createTerminalRoutes } from '../../terminal/routes.js'

const tempDirs = []

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
      headers: {},
      status(code) {
        this.statusCode = code
        return this
      },
      setHeader(name, value) {
        this.headers[name.toLowerCase()] = value
      },
      json(payload) {
        resolve({ statusCode: this.statusCode, payload, headers: this.headers })
      },
      send(payload) {
        resolve({ statusCode: this.statusCode, payload, headers: this.headers })
      },
      end(payload) {
        resolve({ statusCode: this.statusCode, payload, headers: this.headers })
      },
    }

    router.handle(req, res, (err) => {
      if (err) reject(err)
      else resolve({ statusCode: res.statusCode, payload: undefined, headers: res.headers })
    })
  })
}

function encodeClaudeProjectDir(cwd) {
  return cwd.replace(/\//g, '-')
}

function writeJsonlSession(homeDir, cwd, sessionId, promptText, mtimeMs) {
  const projectDir = path.join(homeDir, '.claude', 'projects', encodeClaudeProjectDir(cwd))
  mkdirSync(projectDir, { recursive: true })
  const jsonlPath = path.join(projectDir, `${sessionId}.jsonl`)
  writeFileSync(
    jsonlPath,
    [
      JSON.stringify({
        type: 'user',
        uuid: `${sessionId}-user`,
        cwd,
        message: { role: 'user', content: promptText },
      }),
      JSON.stringify({
        type: 'assistant',
        uuid: `${sessionId}-assistant`,
        requestId: `${sessionId}-req`,
        message: { role: 'assistant', content: [{ type: 'text', text: `reply for ${sessionId}` }] },
      }),
    ].join('\n') + '\n'
  )
  const stamp = new Date(mtimeMs)
  utimesSync(jsonlPath, stamp, stamp)
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

describe('claude resume cache route', () => {
  it('primes recent-agent cache during history restore so /resume works before opening the drawer', async () => {
    const tempRoot = makeTempDir('nanocode-claude-resume-')
    const homeDir = path.join(tempRoot, 'home')
    const projectCwd = path.join(homeDir, 'workspace', 'resume-project')
    mkdirSync(projectCwd, { recursive: true })

    const olderSessionId = '11111111-1111-4111-8111-111111111111'
    const newerSessionId = '22222222-2222-4222-8222-222222222222'
    const now = Date.now()
    writeJsonlSession(homeDir, projectCwd, olderSessionId, 'older prompt', now - 60_000)
    writeJsonlSession(homeDir, projectCwd, newerSessionId, 'newer prompt', now - 45_000)

    await withProcessEnv({ HOME: homeDir }, async () => {
      const store = createStore(':memory:')
      const project = store.createProject('Resume Project', projectCwd)
      // Strict isolation: a tab loads only its own session, never the newest jsonl
      // in the cwd. So pin the tab to newerSessionId explicitly (CASE A) — the
      // route no longer auto-adopts the directory's newest file.
      const tab = store.createTab(project.id, { type: 'claude', label: 'claude resume', claudeSessionId: newerSessionId })
      const { router, handleTerminalWs } = createTerminalRoutes(store)

      const historyRes = await invokeRoute(
        router,
        'GET',
        `/api/projects/${project.id}/tabs/${tab.id}/history`
      )
      assert.equal(historyRes.statusCode, 200)
      assert.equal(historyRes.payload.sessionId, newerSessionId)

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
      emitJson(ws, { type: 'claude-input', text: '/resume', _nonce: 'resume-nonce' })

      const resumeTrigger = await waitUntil(
        () => ws.sent.find((m) => m.type === 'claude-event' && m.event?.subtype === 'resume-trigger'),
        3000,
        'resume-trigger event'
      )

      assert.equal(resumeTrigger.event.sessionId, olderSessionId)

      store.close()
      ws.close()
    })
  })
})
