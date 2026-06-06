import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createCodexSdkDriver } from '../../terminal/codex-sdk-driver.js'

function createDeferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function createCodexImplFactory(plan, calls) {
  let turnIndex = 0

  function makeThread(mode, threadId, options) {
    calls.threadCalls.push({ mode, threadId, options })
    return {
      async runStreamed(prompt, { signal } = {}) {
        const current = plan[turnIndex++] || {}
        calls.turnCalls.push({ mode, threadId, prompt, options, signal })

        async function* events() {
          if (current.waitFor) await current.waitFor
          if (current.signalError && signal) {
            if (signal.aborted) throw current.signalError
            await new Promise((resolve, reject) => {
              signal.addEventListener('abort', () => reject(current.signalError), { once: true })
            })
          }
          for (const event of current.events || []) {
            yield event
          }
          if (current.error) throw current.error
        }

        return { events: events() }
      },
    }
  }

  return class FakeCodex {
    constructor(options = {}) {
      calls.codexOptions.push(options)
    }

    startThread(options = {}) {
      return makeThread('start', null, options)
    }

    resumeThread(id, options = {}) {
      return makeThread('resume', id, options)
    }
  }
}

describe('codex sdk driver', () => {
  it('forwards raw events, renders PTY-style output, and persists thread metadata', async () => {
    const textEvents = []
    const rawEvents = []
    const metadataUpdates = []
    const calls = { codexOptions: [], threadCalls: [], turnCalls: [] }
    const store = {
      getSetting(key) {
        if (key === 'codex_model') return 'gpt-5-codex'
        if (key === 'codex_effort') return 'high'
        if (key === 'codex_sandbox_mode') return 'workspace-write'
        if (key === 'codex_path_override') return '/tmp/codex-bin'
        return null
      },
      updateTabMetadata(projectId, tabId, patch) {
        metadataUpdates.push({ projectId, tabId, patch })
      },
    }
    const FakeCodex = createCodexImplFactory([
      {
        events: [
          { type: 'thread.started', thread_id: 'thread-1' },
          { type: 'item.started', item: { type: 'command_execution', id: 'cmd-1', command: 'ls -la', status: 'in_progress', aggregated_output: '' } },
          { type: 'item.completed', item: { type: 'command_execution', id: 'cmd-1', command: 'ls -la', status: 'completed', aggregated_output: 'file-a\nfile-b', exit_code: 0 } },
          { type: 'item.completed', item: { type: 'file_change', id: 'chg-1', status: 'completed', changes: [{ kind: 'update', path: 'src/app.js' }] } },
          { type: 'item.completed', item: { type: 'agent_message', id: 'msg-1', text: 'Done.' } },
          { type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 2, reasoning_output_tokens: 0 } },
        ],
      },
    ], calls)

    const driver = createCodexSdkDriver({
      store,
      codexBroadcast: (_cs, text) => { textEvents.push(text) },
      codexBroadcastEvent: (_cs, event) => { rawEvents.push(event) },
      rerunTurn: () => { throw new Error('rerunTurn should not be called') },
      CodexImpl: FakeCodex,
    })

    const cs = {
      codexThreadId: null,
      busy: false,
      turnCount: 0,
      queue: [],
      clients: new Set(),
    }

    await driver.runCodexTurn(cs, 'summarize repo', 'project-1:codex:tab-1', '/tmp/workspace')

    assert.deepEqual(calls.codexOptions, [{ codexPathOverride: '/tmp/codex-bin' }])
    assert.equal(calls.threadCalls.length, 1)
    assert.deepEqual(calls.threadCalls[0], {
      mode: 'start',
      threadId: null,
      options: {
        workingDirectory: '/tmp/workspace',
        skipGitRepoCheck: true,
        approvalPolicy: 'never',
        sandboxMode: 'workspace-write',
        networkAccessEnabled: true,
        model: 'gpt-5-codex',
        modelReasoningEffort: 'high',
      },
    })
    assert.equal(calls.turnCalls[0].prompt, 'summarize repo')
    assert.equal(cs.codexThreadId, 'thread-1')
    assert.deepEqual(metadataUpdates, [
      { projectId: 'project-1', tabId: 'tab-1', patch: { codexThreadId: 'thread-1' } },
    ])
    assert.deepEqual(rawEvents.map((event) => event.type), [
      'thread.started',
      'item.started',
      'item.completed',
      'item.completed',
      'item.completed',
      'turn.completed',
    ])
    assert.deepEqual(textEvents, [
      '› summarize repo\n',
      'Running: ls -la\n',
      'file-a\nfile-b\n',
      'patch: update src/app.js\n',
      'Done.\n',
      '────────────\n',
    ])
    assert.equal(cs.busy, false)
    assert.equal(cs.currentProc, null)
  })

  it('resumes existing threads and drains queued prompts one turn at a time', async () => {
    const textEvents = []
    const reruns = []
    const calls = { codexOptions: [], threadCalls: [], turnCalls: [] }
    const firstTurnGate = createDeferred()
    const store = {
      getSetting() {
        return null
      },
    }
    const FakeCodex = createCodexImplFactory([
      {
        waitFor: firstTurnGate.promise,
        events: [
          { type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } },
        ],
      },
    ], calls)

    const driver = createCodexSdkDriver({
      store,
      codexBroadcast: (_cs, text) => { textEvents.push(text) },
      codexBroadcastEvent: () => {},
      rerunTurn: (...args) => { reruns.push(args) },
      CodexImpl: FakeCodex,
    })

    const cs = {
      codexThreadId: 'thread-existing',
      busy: false,
      turnCount: 2,
      queue: [],
      clients: new Set(),
    }

    const firstRun = driver.runCodexTurn(cs, 'first', 'project-1:codex:tab-2', '/tmp/workspace')
    await Promise.resolve()

    await driver.runCodexTurn(cs, 'second', 'project-1:codex:tab-2', '/tmp/workspace')
    await driver.runCodexTurn(cs, 'third', 'project-1:codex:tab-2', '/tmp/workspace')

    assert.equal(calls.threadCalls[0].mode, 'resume')
    assert.equal(calls.threadCalls[0].threadId, 'thread-existing')
    assert.deepEqual(textEvents.slice(0, 3), [
      '› first\n',
      '[queued: Message queued (position 1). Will run after current turn.]\n',
      '[queued: Message queued (position 2). Will run after current turn.]\n',
    ])

    firstTurnGate.resolve()
    await firstRun
    await new Promise((resolve) => setImmediate(resolve))

    assert.equal(reruns.length, 1)
    assert.equal(reruns[0][0], cs)
    assert.equal(reruns[0][1], 'second')
    assert.equal(reruns[0][2], 'project-1:codex:tab-2')
    assert.equal(reruns[0][3], '/tmp/workspace')
    assert.deepEqual(cs.queue, ['third'])
  })

  it('emits interrupt fallback output and clears queued prompts after abort', async () => {
    const textEvents = []
    const reruns = []
    const calls = { codexOptions: [], threadCalls: [], turnCalls: [] }
    const store = {
      getSetting() {
        return null
      },
    }
    const FakeCodex = createCodexImplFactory([
      {
        signalError: Object.assign(new Error('aborted'), { name: 'AbortError' }),
      },
    ], calls)

    const driver = createCodexSdkDriver({
      store,
      codexBroadcast: (_cs, text) => { textEvents.push(text) },
      codexBroadcastEvent: () => {},
      rerunTurn: (...args) => { reruns.push(args) },
      CodexImpl: FakeCodex,
    })

    const cs = {
      codexThreadId: 'thread-existing',
      busy: false,
      turnCount: 1,
      queue: [],
      clients: new Set(),
    }

    const run = driver.runCodexTurn(cs, 'first', 'project-1:codex:tab-3', '/tmp/workspace')
    await Promise.resolve()
    await driver.runCodexTurn(cs, 'queued after interrupt', 'project-1:codex:tab-3', '/tmp/workspace')

    assert.equal(typeof cs.currentProc?.kill, 'function')
    cs.currentProc.kill('SIGINT')
    await run

    assert.equal(reruns.length, 0)
    assert.deepEqual(cs.queue, [])
    assert.deepEqual(textEvents, [
      '› first\n',
      '[queued: Message queued (position 1). Will run after current turn.]\n',
      '[Request interrupted by user]\n',
      '────────────\n',
      '[Queue cleared (1 pending message discarded after interrupt).]\n',
    ])
  })
})
