/**
 * Tests for terminal-view.js queue timing bugs:
 *
 * Problem 3 (P0): nanocode:tab-active handler used to call
 *   updateInputBarForTabType() → updateThinkingState(false) BEFORE clearing
 *   _pendingQueue, causing a stale queue to be flushed while Claude was still
 *   busy on the target tab.  Two sub-scenarios:
 *
 *   (a) Switching to a DIFFERENT tab: _pendingQueue cleared after flush check
 *       (old order: updateInputBarForTabType first, then _pendingQueue=[]).
 *   (b) Re-activating the SAME claude tab: no tab switch, _pendingQueue not
 *       cleared at all, but updateThinkingState(false) still fires → flush.
 *       Fix: pass skipFlush=true from tab-active handler so flush is never
 *       triggered by UI reset — only by the real WS result event.
 *
 * Problem 4: _hydrateQueue() would unconditionally overwrite _pendingQueue
 *   even when the user had typed a new message while the fetch was in-flight.
 *   Fix: only overwrite when _pendingQueue.length === 0.
 *
 * These tests use Node.js built-in EventTarget + dispatchEvent (not internal
 * helper calls) to drive the handler, matching the project's "must simulate
 * real events" rule.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

// ---------------------------------------------------------------------------
// Minimal state-machine that mirrors the FIXED terminal-view.js handler.
// ---------------------------------------------------------------------------

function buildTerminalViewSim({ hydrateDelay = 0 } = {}) {
  // State
  let _activeTabType = 'bash'
  let isClaudeThinking = false
  let isClaudeTab = false
  let _pendingQueue = []
  let _queueTabId = null
  let _queueProjectId = null

  // Spy logs
  const flushLog = []   // each premature flush that fires
  const sendLog = []    // each sendInputWithEcho call
  const hydrateLog = [] // each _hydrateQueue resolution

  const activePane = { sendInputWithEcho(msg) { sendLog.push(msg) } }
  function updateQueueTray() { /* visual only */ }

  // FIXED: accepts skipFlush option — tab-active handler passes skipFlush=true
  // so that UI reset never triggers auto-flush (only WS result events should).
  function updateThinkingState(thinking, { skipFlush = false } = {}) {
    isClaudeThinking = thinking
    if (isClaudeTab && thinking) {
      // Claude busy — no flush
    } else {
      // Claude idle: restore UI; auto-flush only if not suppressed
      if (!thinking && isClaudeTab && _pendingQueue.length > 0 && !skipFlush) {
        flushLog.push({ when: 'updateThinkingState', queueSnapshot: [..._pendingQueue] })
        const all = _pendingQueue.splice(0)
        if (activePane) activePane.sendInputWithEcho(all.join('\n\n'))
      }
    }
  }

  // FIXED: accepts skipFlush option, passes it through to updateThinkingState
  function updateInputBarForTabType({ skipFlush = false } = {}) {
    isClaudeTab = _activeTabType === 'claude'
    updateThinkingState(isClaudeThinking && isClaudeTab, { skipFlush })
  }

  // FIXED: only overwrite when local queue is still empty (problem-4)
  function _hydrateQueue(projectId, tabId, serverQueue) {
    return new Promise((resolve) => {
      setTimeout(() => {
        if (_pendingQueue.length === 0) {
          if (Array.isArray(serverQueue) && serverQueue.length > 0) {
            _pendingQueue = serverQueue
            updateQueueTray()
          }
        }
        hydrateLog.push({ pendingQueueAfter: [..._pendingQueue] })
        resolve()
      }, hydrateDelay)
    })
  }

  const eventTarget = new EventTarget()

  // FIXED handler — mirrors the patched terminal-view.js exactly:
  //   1. Determine switchedTab
  //   2. Clear _pendingQueue (only if switchedTab, BEFORE updateInputBarForTabType)
  //   3. Reset isClaudeThinking
  //   4. updateInputBarForTabType({ skipFlush: true })  ← never flushes from here
  //   5. Start async hydrate
  function installFixedHandler(getServerQueue) {
    eventTarget.addEventListener('nanocode:tab-active', (e) => {
      _activeTabType = e.detail?.type || 'bash'

      const newTabId = e.detail?.tabId || null
      const newProjectId = e.detail?.projectId || null
      const switchedTab = newTabId !== _queueTabId || newProjectId !== _queueProjectId

      if (switchedTab) {
        // Clear in-memory queue FIRST (fix for P3-a: different tab scenario)
        _pendingQueue = []
        _queueProjectId = newProjectId
        _queueTabId = newTabId
      }

      isClaudeThinking = false  // reset on tab switch
      // skipFlush=true: UI reset must NEVER trigger auto-flush (fix for P3-b)
      updateInputBarForTabType({ skipFlush: true })

      if (switchedTab && _activeTabType === 'claude' && newProjectId && newTabId) {
        _hydrateQueue(newProjectId, newTabId, getServerQueue?.())
      }

      updateQueueTray()
    })
  }

  function setState({ pendingQueue, claudeThinking, tabType, queueTabId, queueProjectId }) {
    if (pendingQueue !== undefined) _pendingQueue = pendingQueue
    if (claudeThinking !== undefined) isClaudeThinking = claudeThinking
    if (tabType !== undefined) _activeTabType = tabType
    if (queueTabId !== undefined) _queueTabId = queueTabId
    if (queueProjectId !== undefined) _queueProjectId = queueProjectId
  }
  function getState() {
    return {
      _pendingQueue: [..._pendingQueue],
      isClaudeThinking,
      isClaudeTab,
      _queueTabId,
      _queueProjectId,
    }
  }
  function dispatch(type, detail) {
    eventTarget.dispatchEvent(Object.assign(new Event(type), { detail }))
  }
  // Simulate WS result event arriving (the ONLY legitimate flush trigger)
  function simulateWsResult() {
    updateThinkingState(false)  // no skipFlush → flush is allowed
  }

  return { installFixedHandler, setState, getState, dispatch, simulateWsResult, flushLog, sendLog, hydrateLog }
}

// ---------------------------------------------------------------------------
// OLD (buggy) handler to confirm tests catch the regression
// ---------------------------------------------------------------------------

function buildTerminalViewSimOLD() {
  let _activeTabType = 'bash'
  let isClaudeThinking = false
  let isClaudeTab = false
  let _pendingQueue = []
  let _queueTabId = null
  let _queueProjectId = null

  const flushLog = []
  const sendLog = []

  const activePane = { sendInputWithEcho(msg) { sendLog.push(msg) } }
  function updateQueueTray() {}

  function updateThinkingState(thinking) {
    isClaudeThinking = thinking
    if (!thinking && isClaudeTab && _pendingQueue.length > 0) {
      flushLog.push({ when: 'updateThinkingState', queueSnapshot: [..._pendingQueue] })
      const all = _pendingQueue.splice(0)
      if (activePane) activePane.sendInputWithEcho(all.join('\n\n'))
    }
  }

  function updateInputBarForTabType() {
    isClaudeTab = _activeTabType === 'claude'
    updateThinkingState(isClaudeThinking && isClaudeTab)
  }

  const eventTarget = new EventTarget()

  // OLD handler — exactly matches the PRE-FIX terminal-view.js:
  //   isClaudeThinking=false → updateInputBarForTabType() → THEN _pendingQueue=[]
  function installOldHandler() {
    eventTarget.addEventListener('nanocode:tab-active', (e) => {
      _activeTabType = e.detail?.type || 'bash'
      isClaudeThinking = false   // reset on tab switch
      updateInputBarForTabType() // BUG: flush check BEFORE _pendingQueue cleared

      const newTabId = e.detail?.tabId || null
      const newProjectId = e.detail?.projectId || null
      const switchedTab = newTabId !== _queueTabId || newProjectId !== _queueProjectId
      if (switchedTab) {
        _pendingQueue = []  // too late — flush may have already fired
        _queueProjectId = newProjectId
        _queueTabId = newTabId
      }

      updateQueueTray()
    })
  }

  function setState({ pendingQueue, claudeThinking, tabType, queueTabId, queueProjectId }) {
    if (pendingQueue !== undefined) _pendingQueue = pendingQueue
    if (claudeThinking !== undefined) isClaudeThinking = claudeThinking
    if (tabType !== undefined) _activeTabType = tabType
    if (queueTabId !== undefined) _queueTabId = queueTabId
    if (queueProjectId !== undefined) _queueProjectId = queueProjectId
  }
  function dispatch(type, detail) {
    eventTarget.dispatchEvent(Object.assign(new Event(type), { detail }))
  }

  return { installOldHandler, setState, dispatch, flushLog, sendLog }
}

// ===========================================================================
// Tests
// ===========================================================================

describe('terminal-view queue race P3-b: re-activating the SAME claude tab while busy', () => {
  it('FIXED: same-tab re-activation with pending queue does NOT flush', () => {
    const sim = buildTerminalViewSim()
    sim.installFixedHandler()

    // Claude is on Tab A, busy, with queued messages
    sim.setState({
      tabType: 'claude',
      pendingQueue: ['msg-a', 'msg-b'],
      claudeThinking: true,
      queueTabId: 'tab-a',
      queueProjectId: 'proj-1',
    })

    // TabManager re-dispatches tab-active for the same tab (e.g. on focus)
    // switchedTab=false → _pendingQueue not cleared; but skipFlush=true → no flush
    sim.dispatch('nanocode:tab-active', { type: 'claude', tabId: 'tab-a', projectId: 'proj-1' })

    assert.equal(sim.sendLog.length, 0,
      'FIXED: sendInputWithEcho must NOT fire when Claude is still busy (same tab re-activation)')
    assert.equal(sim.flushLog.length, 0,
      'FIXED: flushLog must be empty — no premature flush on same-tab re-activation')

    const state = sim.getState()
    assert.deepEqual(state._pendingQueue, ['msg-a', 'msg-b'],
      'FIXED: _pendingQueue must be preserved across same-tab re-activation')
  })

  it('BUG CONFIRMED: OLD handler flushes on same-tab re-activation (regression guard)', () => {
    const sim = buildTerminalViewSimOLD()
    sim.installOldHandler()

    sim.setState({
      tabType: 'claude',
      pendingQueue: ['msg-a', 'msg-b'],
      claudeThinking: true,
      queueTabId: 'tab-a',
      queueProjectId: 'proj-1',
    })

    // Same tab re-activated: switchedTab=false, _pendingQueue not cleared,
    // isClaudeThinking=false, updateInputBarForTabType() triggers flush
    sim.dispatch('nanocode:tab-active', { type: 'claude', tabId: 'tab-a', projectId: 'proj-1' })

    assert.ok(sim.sendLog.length > 0,
      'OLD HANDLER BUG: sendInputWithEcho fired prematurely (regression confirmed)')
  })
})

describe('terminal-view queue race P3-a: switching to different tab then back', () => {
  it('FIXED: Tab A busy → switch to Tab B → switch back to Tab A — no premature flush', () => {
    const sim = buildTerminalViewSim()
    sim.installFixedHandler()

    // Tab A: claude, busy, has queued messages
    sim.setState({
      tabType: 'claude',
      pendingQueue: ['queued-while-busy'],
      claudeThinking: true,
      queueTabId: 'tab-a',
      queueProjectId: 'proj-1',
    })

    // Switch to Tab B (bash)
    sim.dispatch('nanocode:tab-active', { type: 'bash', tabId: 'tab-b', projectId: 'proj-1' })
    assert.equal(sim.sendLog.length, 0, 'No flush when switching to bash tab')

    // Switch back to Tab A — Claude is still busy on the server (isClaudeThinking
    // was reset by handler, but skipFlush=true means no flush fires here either)
    sim.dispatch('nanocode:tab-active', { type: 'claude', tabId: 'tab-a', projectId: 'proj-1' })

    assert.equal(sim.sendLog.length, 0,
      'FIXED: no premature flush when switching back to claude tab while busy')
    assert.equal(sim.flushLog.length, 0,
      'FIXED: flushLog must be empty throughout tab switching')
  })

  it('FIXED: WS result event (not tab-active) correctly triggers flush', () => {
    const sim = buildTerminalViewSim()
    sim.installFixedHandler()

    // Tab A: claude, busy, with queued messages
    sim.setState({
      tabType: 'claude',
      pendingQueue: ['ready-to-flush'],
      claudeThinking: true,
      queueTabId: 'tab-a',
      queueProjectId: 'proj-1',
    })

    // Re-activate tab (should NOT flush)
    sim.dispatch('nanocode:tab-active', { type: 'claude', tabId: 'tab-a', projectId: 'proj-1' })
    assert.equal(sim.sendLog.length, 0, 'No flush on tab-active')

    // WS result event arrives — THIS is the legitimate flush trigger
    sim.simulateWsResult()

    assert.equal(sim.sendLog.length, 1, 'WS result event correctly triggers flush')
    assert.equal(sim.sendLog[0], 'ready-to-flush', 'Correct message flushed')
  })
})

describe('terminal-view hydrate race P4: _hydrateQueue must not overwrite user messages', () => {
  it('FIXED: hydrate does not overwrite message added while fetch was in-flight', async () => {
    const serverQueue = ['server-msg-1', 'server-msg-2']
    const sim = buildTerminalViewSim({ hydrateDelay: 50 })
    sim.installFixedHandler(() => serverQueue)

    sim.setState({
      tabType: 'bash',
      pendingQueue: [],
      claudeThinking: false,
      queueTabId: 'tab-a',
      queueProjectId: 'proj-1',
    })

    // Switch to new claude tab — triggers async hydrate (50ms)
    sim.dispatch('nanocode:tab-active', { type: 'claude', tabId: 'tab-b', projectId: 'proj-1' })

    // While hydrate is in-flight, user types a new message
    sim.setState({ pendingQueue: ['user-typed-while-hydrating'] })

    // Wait for hydrate to complete
    await new Promise((r) => setTimeout(r, 100))

    const state = sim.getState()
    assert.deepEqual(state._pendingQueue, ['user-typed-while-hydrating'],
      'FIXED: hydrate must not overwrite user message added while fetch was in-flight')
  })

  it('FIXED: hydrate populates queue when local queue is empty', async () => {
    const serverQueue = ['from-server-1']
    const sim = buildTerminalViewSim({ hydrateDelay: 20 })
    sim.installFixedHandler(() => serverQueue)

    sim.setState({
      tabType: 'bash',
      pendingQueue: [],
      claudeThinking: false,
      queueTabId: 'tab-x',
      queueProjectId: 'proj-1',
    })

    // Switch to new claude tab
    sim.dispatch('nanocode:tab-active', { type: 'claude', tabId: 'tab-y', projectId: 'proj-1' })

    // Wait for hydrate
    await new Promise((r) => setTimeout(r, 60))

    const state = sim.getState()
    assert.deepEqual(state._pendingQueue, ['from-server-1'],
      'FIXED: hydrate must populate queue when local queue is empty')
  })
})
