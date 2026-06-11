import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createAgentHealthMonitor } from '../../terminal/agent-health-monitor.js'

function makeStore(settings = {}) {
  return {
    getSetting(key) {
      return Object.prototype.hasOwnProperty.call(settings, key) ? settings[key] : null
    },
  }
}

describe('agent health monitor', () => {
  it('emits idle and active recovery events with snapshot state', () => {
    let current = 1_700_000_000_000
    const emitted = []
    const monitor = createAgentHealthMonitor({
      store: makeStore({ agent_health_idle_threshold_sec: '20' }),
      now: () => current,
      autoStart: false,
    })
    monitor.setNotifier((msg) => emitted.push(msg))

    const meta = {
      sessionKey: 'project-1:claude:tab-1',
      projectId: 'project-1',
      tabId: 'tab-1',
      tabType: 'claude',
      provider: 'claude',
      source: 'claude-sdk',
      sessionId: 'sess-1',
    }

    monitor.startTracking(meta)
    monitor.recordOutput(meta, 'Thinking...')

    current += 21_000
    const idleEvents = monitor.scanNow()
    assert.equal(idleEvents.length, 1)
    assert.equal(idleEvents[0].state, 'idle')
    assert.equal(idleEvents[0].reason, 'idle_timeout')
    assert.equal(idleEvents[0].idle_seconds, 21)

    const snapshot = monitor.listSnapshot()
    assert.equal(snapshot.agents.length, 1)
    assert.equal(snapshot.agents[0].state, 'idle')
    assert.equal(snapshot.agents[0].session_id, 'sess-1')

    current += 1_000
    monitor.recordOutput(meta, 'Resumed output')
    assert.equal(emitted.at(-1).state, 'active')
    assert.equal(emitted.at(-1).reason, 'recent_output')
  })

  it('emits approval_needed and stuck for configured terminal patterns', () => {
    let current = 1_700_000_100_000
    const emitted = []
    const monitor = createAgentHealthMonitor({
      store: makeStore({
        agent_health_idle_threshold_sec: '20',
        agent_health_background_wait_threshold_sec: '240',
      }),
      now: () => current,
      autoStart: false,
    })
    monitor.setNotifier((msg) => emitted.push(msg))

    const approvalMeta = {
      sessionKey: 'project-1:claude:tab-approval',
      projectId: 'project-1',
      tabId: 'tab-approval',
      tabType: 'claude',
      provider: 'claude',
      source: 'claude-sdk',
      sessionId: 'sess-approval',
    }
    monitor.startTracking(approvalMeta)
    monitor.recordOutput(approvalMeta, 'Press enter to confirm or esc to cancel')
    assert.equal(emitted.at(-1).state, 'approval_needed')
    assert.equal(emitted.at(-1).reason, 'approval_prompt')

    const stuckMeta = {
      sessionKey: 'project-1:codex:tab-stuck',
      projectId: 'project-1',
      tabId: 'tab-stuck',
      tabType: 'codex',
      provider: 'codex',
      source: 'codex-sdk',
      threadId: 'thread-stuck',
    }
    monitor.startTracking(stuckMeta)
    monitor.recordOutput(stuckMeta, 'Waiting for background terminal (4m 12s)')
    assert.equal(emitted.at(-1).state, 'stuck')
    assert.equal(emitted.at(-1).reason, 'background_terminal_wait')
    assert.equal(emitted.at(-1).wait_seconds, 252)
  })

  it('finishes Claude sessions on result events and removes them from snapshot', () => {
    let current = 1_700_000_200_000
    const emitted = []
    const monitor = createAgentHealthMonitor({
      store: makeStore(),
      now: () => current,
      autoStart: false,
    })
    monitor.setNotifier((msg) => emitted.push(msg))

    const meta = {
      sessionKey: 'project-2:claude:tab-2',
      projectId: 'project-2',
      tabId: 'tab-2',
      tabType: 'claude',
      provider: 'claude',
      source: 'claude-cli',
      sessionId: 'sess-2',
    }

    monitor.startTracking(meta)
    monitor.recordClaudeEvent(meta, {
      type: 'assistant',
      session_id: 'sess-2',
      message: { role: 'assistant', content: [{ type: 'text', text: 'still working' }] },
    })
    monitor.recordClaudeEvent(meta, {
      type: 'result',
      subtype: 'success',
      session_id: 'sess-2',
      result: 'done',
    })

    assert.equal(emitted.at(-1).state, 'completed')
    assert.equal(emitted.at(-1).reason, 'success')
    assert.equal(monitor.listSnapshot().agents.length, 0)
  })
})
