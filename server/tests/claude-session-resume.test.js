/**
 * Unit tests for the explicit vs implicit sessionId handling in attachClaudeSession.
 *
 * Bug: when tab.claudeSessionId collides with CLAUDE_CODE_SESSION_ID (the running
 * nanocode process session), _activeSessionOverride fired unconditionally and forced
 * turnCount=0 (new-session path), even when the sessionId was explicitly chosen by
 * the user (e.g. via Recent Agents). This caused the spawn to use --session-id
 * (fresh session) instead of --resume (continuing the conversation), so Claude had
 * no prior context even though history showed 900+ events.
 *
 * Fix: _activeSessionOverride only fires when the sessionId is IMPLICIT (no stored
 * claudeSessionId in tab metadata). For EXPLICIT sessionIds, we trust the user's
 * intent and let initialTurnCount=1 (resume path) proceed.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createClaudeSessionController } from '../../terminal/claude-session-controller.js'

/**
 * Create a minimal mock WebSocket that records sent messages and simulates
 * a single 'message' event for the attach handshake.
 */
function makeMockWs(attachMsg) {
  const listeners = {}
  const sent = []
  const ws = {
    readyState: 1,
    send(msg) { sent.push(JSON.parse(msg)) },
    on(event, fn) {
      if (!listeners[event]) listeners[event] = []
      listeners[event].push(fn)
    },
    once(event, fn) {
      const wrapper = (...args) => {
        fn(...args)
        ws.off?.(event, wrapper)
      }
      ws.on(event, wrapper)
    },
    off(event, fn) {
      if (!listeners[event]) return
      listeners[event] = listeners[event].filter(l => l !== fn)
    },
    removeListener(event, fn) {
      ws.off(event, fn)
    },
    emit(event, ...args) {
      for (const fn of (listeners[event] || [])) fn(...args)
    },
    _sent: sent,
  }
  // Trigger the initial attach message on the next tick
  setImmediate(() => ws.emit('message', JSON.stringify(attachMsg)))
  return ws
}

/**
 * Build a minimal session controller with mocked store/recentAgents.
 * Returns { controller, claudeSessions, getCs }.
 */
function makeController({ tabClaudeSessionId, mainSessionId, hasSeedHistory = false }) {
  const projectId = 'proj-1'
  const tabId = 'tab-1'

  const store = {
    getSetting(key) {
      if (key === 'renderMode') return 'block'
      if (key === 'claude_autoresume') return '1'
      if (key === 'claude_driver') return 'cli' // use CLI path so we don't need SDK
      return null
    },
    getProject(id) {
      if (id !== projectId) return null
      return { id: projectId, cwd: '/tmp/test-proj', ssh_host: null }
    },
    getTab(pid, tid) {
      if (pid !== projectId || tid !== tabId) return null
      return { id: tabId, type: 'claude', claudeSessionId: tabClaudeSessionId || null, label: 'Test' }
    },
    updateTabMetadata() {},
    listTabs() { return [] },
  }

  const recentAgents = {
    getRecentAgentsCached() { return [] },
    primeRecentAgentsCache() {},
  }

  // Temporarily set CLAUDE_CODE_SESSION_ID env var if needed
  const origEnv = process.env.CLAUDE_CODE_SESSION_ID
  if (mainSessionId) {
    process.env.CLAUDE_CODE_SESSION_ID = mainSessionId
  } else {
    delete process.env.CLAUDE_CODE_SESSION_ID
  }

  const controller = createClaudeSessionController({ store, home: '/tmp', recentAgents })

  // If a seed history should exist, prime it before attach
  if (hasSeedHistory) {
    controller.primeReplayHistory(projectId, tabId, [
      { type: 'user', uuid: 'u1', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } },
    ])
  }

  function getCs() {
    return controller.claudeSessions.get(`${projectId}:claude:${tabId}`)
  }

  function triggerAttach() {
    return new Promise((resolve) => {
      const ws = makeMockWs({ type: 'attach', projectId, tabId, sessionType: 'bash' })
      controller.handleTerminalWs(ws)
      // Wait for attach to process (setImmediate fires the 'message' event)
      setImmediate(() => resolve(getCs()))
    })
  }

  return { controller, triggerAttach, getCs, restoreEnv: () => {
    if (origEnv !== undefined) {
      process.env.CLAUDE_CODE_SESSION_ID = origEnv
    } else {
      delete process.env.CLAUDE_CODE_SESSION_ID
    }
  }}
}

describe('claude session resume — explicit vs implicit sessionId', () => {
  it('explicit sessionId + active-guard trigger: turnCount=1 (resume path)', async () => {
    // Scenario: user explicitly chose session ABC via Recent Agents.
    // Tab metadata has claudeSessionId=ABC. The running nanocode process also uses ABC.
    // With the fix: active-guard does NOT fire → initialTurnCount=1 → resume path.
    const { triggerAttach, restoreEnv } = makeController({
      tabClaudeSessionId: 'explicit-abc',
      mainSessionId: 'explicit-abc', // same as tab → would previously trigger override
      hasSeedHistory: true,
    })
    try {
      const cs = await triggerAttach()
      assert.ok(cs, 'claude session should be created')
      assert.equal(cs.turnCount, 1, 'explicit sessionId with history should use resume path (turnCount=1)')
      // The claudeSessionId should remain the explicit one (not replaced by fresh UUID)
      assert.equal(cs.claudeSessionId, 'explicit-abc', 'explicit sessionId should not be replaced')
    } finally {
      restoreEnv()
    }
  })

  it('implicit sessionId + active jsonl: turnCount=0 (new session, guard active)', async () => {
    // Scenario: tab has no stored claudeSessionId (new/implicit tab).
    // The running nanocode process uses XYZ.
    // The active-guard should fire → fresh UUID → turnCount=0 (new session).
    // (In practice the history endpoint would detect the collision and assign a fresh
    // UUID before primeReplayHistory is called, but we test the controller path here.)
    const { triggerAttach, getCs, restoreEnv } = makeController({
      tabClaudeSessionId: null,  // implicit — no stored session
      mainSessionId: 'implicit-xyz',
      hasSeedHistory: false, // guard fires → no seed → turnCount=0
    })
    try {
      const cs = await triggerAttach()
      assert.ok(cs, 'claude session should be created')
      assert.equal(cs.turnCount, 0, 'implicit sessionId with active guard should use new-session path (turnCount=0)')
    } finally {
      restoreEnv()
    }
  })

  it('explicit sessionId, no active-guard collision: turnCount=1 when history present', async () => {
    // Normal resume case: explicit sessionId, different from main session (no collision).
    const { triggerAttach, restoreEnv } = makeController({
      tabClaudeSessionId: 'some-other-session',
      mainSessionId: 'main-session-different',
      hasSeedHistory: true,
    })
    try {
      const cs = await triggerAttach()
      assert.ok(cs, 'claude session should be created')
      assert.equal(cs.turnCount, 1, 'explicit sessionId with history and no collision: resume path (turnCount=1)')
      assert.equal(cs.claudeSessionId, 'some-other-session')
    } finally {
      restoreEnv()
    }
  })

  it('no history seed: turnCount=0 even with explicit sessionId (no history to resume)', async () => {
    // Explicit sessionId but no jsonl history primed → no seed → turnCount=0.
    const { triggerAttach, restoreEnv } = makeController({
      tabClaudeSessionId: 'fresh-explicit',
      mainSessionId: 'unrelated-main',
      hasSeedHistory: false,
    })
    try {
      const cs = await triggerAttach()
      assert.ok(cs, 'claude session should be created')
      assert.equal(cs.turnCount, 0, 'no history seed: new-session path (turnCount=0)')
    } finally {
      restoreEnv()
    }
  })
})
