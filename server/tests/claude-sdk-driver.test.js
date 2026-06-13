import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createClaudeSdkDriver } from '../../terminal/claude-sdk-driver.js'

function createDeferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function makeQueryFromPlan(plan, calls) {
  let callIndex = 0
  return ({ prompt, options }) => {
    calls.push({ prompt, options })
    const current = plan[callIndex++] || { events: [] }

    async function* run() {
      for (const event of current.events || []) {
        yield event
      }
      if (current.waitFor) await current.waitFor
      if (current.error) throw current.error
    }

    const iterator = run()
    iterator.interrupt = async () => {
      current.onInterrupt?.()
    }
    iterator.close = async () => {
      current.onClose?.()
    }
    return iterator
  }
}

describe('claude sdk driver', () => {
  it('forwards sdk events and updates session metadata on init', async () => {
    const calls = []
    const broadcasted = []
    const metadataUpdates = []
    const store = {
      getSetting(key) {
        if (key === 'claude_model') return 'claude-opus-4-8'
        if (key === 'claude_effort') return 'high'
        if (key === 'global_permission') return 'full-auto'
        return null
      },
      updateTabMetadata(projectId, tabId, patch) {
        metadataUpdates.push({ projectId, tabId, patch })
      },
    }
    const queryImpl = makeQueryFromPlan([
      {
        events: [
          { type: 'system', subtype: 'init', session_id: 'sdk-session', tools: [] },
          { type: 'assistant', session_id: 'sdk-session', message: { role: 'assistant', content: [{ type: 'text', text: 'OK' }] } },
          { type: 'result', subtype: 'success', session_id: 'sdk-session', result: 'OK' },
        ],
      },
    ], calls)

    const driver = createClaudeSdkDriver({
      store,
      claudeBroadcast: (_cs, event) => { broadcasted.push(event) },
      rerunTurn: () => { throw new Error('rerunTurn should not be called') },
      queryImpl,
    })

    const cs = {
      claudeSessionId: 'initial-session',
      busy: false,
      turnCount: 0,
      queue: [],
      history: [],
      clients: new Set(),
    }

    await driver.runSdkTurn(cs, 'hello sdk', 'project-1:claude:tab-9', process.cwd())

    assert.equal(calls.length, 1)
    assert.equal(calls[0].prompt, 'hello sdk')
    assert.equal(calls[0].options.cwd, process.cwd())
    assert.equal(calls[0].options.sessionId, 'initial-session')
    assert.equal(calls[0].options.resume, undefined)
    assert.equal(calls[0].options.permissionMode, 'bypassPermissions')
    assert.equal(calls[0].options.allowDangerouslySkipPermissions, true)
    assert.equal(calls[0].options.includePartialMessages, true)
    assert.equal(calls[0].options.forwardSubagentText, true)
    assert.equal(calls[0].options.model, 'claude-opus-4-8')
    assert.equal(calls[0].options.effort, 'high')
    assert.equal(cs.claudeSessionId, 'sdk-session')
    assert.deepEqual(metadataUpdates, [
      { projectId: 'project-1', tabId: 'tab-9', patch: { claudeSessionId: 'sdk-session' } },
    ])
    assert.deepEqual(
      broadcasted.map((event) => event.type),
      ['system', 'assistant', 'result']
    )
    assert.equal(cs.busy, false)
    assert.equal(cs.currentProc, null)
  })

  it('queues messages while busy and drains them as one follow-up turn after result', async () => {
    const calls = []
    const broadcasted = []
    const reruns = []
    const firstTurnDone = createDeferred()
    const store = {
      getSetting(key) {
        if (key === 'claude_permission_mode') return 'bypass'
        return null
      },
    }
    const queryImpl = makeQueryFromPlan([
      {
        events: [
          { type: 'system', subtype: 'init', session_id: 'sdk-session', tools: [] },
          { type: 'result', subtype: 'success', session_id: 'sdk-session', result: 'first' },
        ],
        waitFor: firstTurnDone.promise,
      },
    ], calls)

    const driver = createClaudeSdkDriver({
      store,
      claudeBroadcast: (_cs, event) => { broadcasted.push(event) },
      rerunTurn: (...args) => { reruns.push(args) },
      queryImpl,
    })

    const cs = {
      claudeSessionId: 'sdk-session',
      busy: false,
      turnCount: 1,
      queue: [],
      history: [],
      clients: new Set(),
    }

    const firstRun = driver.runSdkTurn(cs, 'first', 'project-1:claude:tab-2', '/tmp/workspace')
    await Promise.resolve()

    await driver.runSdkTurn(cs, 'second', 'project-1:claude:tab-2', '/tmp/workspace')
    await driver.runSdkTurn(cs, 'third', 'project-1:claude:tab-2', '/tmp/workspace')

    assert.equal(cs.queue.length, 2)
    assert.deepEqual(
      broadcasted.filter((event) => event.subtype === 'queued').map((event) => event.text),
      [
        'Message queued (position 1). Will run after current turn.',
        'Message queued (position 2). Will run after current turn.',
      ]
    )

    firstTurnDone.resolve()
    await firstRun
    await new Promise((resolve) => setImmediate(resolve))

    assert.equal(reruns.length, 1)
    assert.equal(reruns[0][0], cs)
    assert.equal(reruns[0][1], 'second\n\nthird')
    assert.equal(reruns[0][2], 'project-1:claude:tab-2')
    assert.equal(reruns[0][3], '/tmp/workspace')
    assert.equal(cs.queue.length, 0)
  })

  it('synthesizes an interrupted result and clears queued messages when the sdk query is interrupted', async () => {
    const calls = []
    const broadcasted = []
    const reruns = []
    const interrupted = createDeferred()
    const store = {
      getSetting(key) {
        if (key === 'claude_permission_mode') return 'bypass'
        return null
      },
    }
    const queryImpl = makeQueryFromPlan([
      {
        events: [
          { type: 'system', subtype: 'init', session_id: 'sdk-session', tools: [] },
        ],
        waitFor: interrupted.promise,
        error: new Error('interrupted by test'),
      },
    ], calls)

    const driver = createClaudeSdkDriver({
      store,
      claudeBroadcast: (_cs, event) => { broadcasted.push(event) },
      rerunTurn: (...args) => { reruns.push(args) },
      queryImpl,
    })

    const cs = {
      claudeSessionId: 'sdk-session',
      busy: false,
      turnCount: 1,
      queue: [],
      history: [],
      clients: new Set(),
    }

    const run = driver.runSdkTurn(cs, 'first', 'project-1:claude:tab-3', '/tmp/workspace')
    await Promise.resolve()
    await driver.runSdkTurn(cs, 'queued after interrupt', 'project-1:claude:tab-3', '/tmp/workspace')

    assert.equal(typeof cs.currentProc?.kill, 'function')
    cs.currentProc.kill('SIGINT')
    interrupted.resolve()
    await run
    // Let setImmediate callbacks fire (auto-flush uses setImmediate(() => rerunTurn(...)))
    await new Promise((resolve) => setImmediate(resolve))

    // After interrupt + auto-flush: rerunTurn fires for the queued message,
    // then queue is drained (length=0). reruns contains the auto-flush call.
    assert.equal(reruns.length, 1)
    assert.equal(reruns[0][1], 'queued after interrupt')
    assert.equal(cs.queue.length, 0)
    // a33d294: interrupt subtype is 'error_during_execution' (matches CLI stdout output)
    assert.equal(
      broadcasted.some((event) => event.type === 'result' && event.subtype === 'error_during_execution'),
      true
    )
    // 9840310: auto-flush emits "Resuming with N queued message(s)…" not "Queue cleared"
    assert.equal(
      broadcasted.some((event) => event.type === 'system' && event.subtype === 'info' && /Resuming with/.test(event.text || '')),
      true
    )
  })

  // ── Permission mapping: global_permission → SDK permissionMode ──────────────
  // Verifies the SDK driver maps all three nanocode permission tiers the same
  // way the CLI driver does, and that allowDangerouslySkipPermissions only fires
  // on the bypass tier. Also covers the legacy claude_permission_mode fallback.
  async function runWithPermission(settings) {
    const calls = []
    const store = {
      getSetting(key) { return settings[key] ?? null },
      updateTabMetadata() {},
    }
    const queryImpl = makeQueryFromPlan([
      {
        events: [
          { type: 'system', subtype: 'init', session_id: 'sdk-session', tools: [] },
          { type: 'result', subtype: 'success', session_id: 'sdk-session', result: 'OK' },
        ],
      },
    ], calls)
    const driver = createClaudeSdkDriver({
      store,
      claudeBroadcast: () => {},
      rerunTurn: () => {},
      queryImpl,
    })
    const cs = {
      claudeSessionId: 's', busy: false, turnCount: 0,
      queue: [], history: [], clients: new Set(),
    }
    await driver.runSdkTurn(cs, 'hi', 'p:claude:t', '/tmp')
    return calls[0].options
  }

  it('maps global_permission=full-auto → bypassPermissions + dangerous skip', async () => {
    const opts = await runWithPermission({ global_permission: 'full-auto' })
    assert.equal(opts.permissionMode, 'bypassPermissions')
    assert.equal(opts.allowDangerouslySkipPermissions, true)
  })

  it('maps global_permission=auto-edits → acceptEdits (no dangerous skip)', async () => {
    const opts = await runWithPermission({ global_permission: 'auto-edits' })
    assert.equal(opts.permissionMode, 'acceptEdits')
    assert.equal(opts.allowDangerouslySkipPermissions, false)
  })

  it('maps global_permission=ask → default (no dangerous skip)', async () => {
    const opts = await runWithPermission({ global_permission: 'ask' })
    assert.equal(opts.permissionMode, 'default')
    assert.equal(opts.allowDangerouslySkipPermissions, false)
  })

  it('defaults to bypassPermissions when no permission setting is present', async () => {
    const opts = await runWithPermission({})
    assert.equal(opts.permissionMode, 'bypassPermissions')
    assert.equal(opts.allowDangerouslySkipPermissions, true)
  })

  it('honours legacy claude_permission_mode=accept-edits when global_permission absent', async () => {
    const opts = await runWithPermission({ claude_permission_mode: 'accept-edits' })
    assert.equal(opts.permissionMode, 'acceptEdits')
    assert.equal(opts.allowDangerouslySkipPermissions, false)
  })

  // ── SDK-wrapped result error suppression (model_not_found / rate_limit etc.) ──
  // When the SDK throws "Claude Code returned an error result: <reason>" (non-resume-miss),
  // the driver must NOT fall back to CLI. The result event was already broadcast, so the
  // client sees the error cleanly without the "SDK error → 已自动切回 CLI" banner.
  it('suppresses CLI fallback for SDK-wrapped api error results (e.g. model_not_found)', async () => {
    const broadcasted = []
    const fallbacks = []
    const store = { getSetting() { return null } }

    // Simulate the SDK broadcasting the error result event THEN throwing the wrapped error.
    let throwFn
    const queryImpl = () => {
      async function* run() {
        yield { type: 'result', subtype: 'success', is_error: true, session_id: 's',
          result: "There's an issue with the selected model (claude-fable-5). It may not exist or you may not have access to it." }
        // After emitting the result, throw like the SDK does internally.
        // We use a deferred approach: the generator throws synchronously after yielding.
        throw new Error("Claude Code returned an error result: There's an issue with the selected model (claude-fable-5). It may not exist or you may not have access to it.")
      }
      const it = run()
      it.interrupt = async () => {}
      it.close = async () => {}
      return it
    }

    const driver = createClaudeSdkDriver({
      store,
      claudeBroadcast: (_cs, event) => { broadcasted.push(event) },
      rerunTurn: () => {},
      runCliFallback: (...args) => { fallbacks.push(args) },
      queryImpl,
    })
    const cs = {
      claudeSessionId: 's', busy: false, turnCount: 0,
      queue: [], history: [], clients: new Set(),
    }
    await driver.runSdkTurn(cs, 'hi', 'p:claude:t', '/tmp')

    // No CLI fallback triggered
    assert.equal(fallbacks.length, 0, 'CLI fallback must NOT be triggered for SDK-wrapped result errors')
    // No sdk_error_fallback system event in the broadcast
    const sdkFallbackEvents = broadcasted.filter((e) => e.subtype === 'sdk_error_fallback')
    assert.equal(sdkFallbackEvents.length, 0, 'sdk_error_fallback system event must NOT be broadcast')
    // The result event WAS broadcast (sawResult=true before throw)
    const resultEvents = broadcasted.filter((e) => e.type === 'result')
    assert.equal(resultEvents.length >= 1, true, 'result event must be broadcast')
    // cs is cleaned up properly
    assert.equal(cs.busy, false)
  })

  it('still falls back to CLI for resume-miss errors even when SDK wraps them as result errors', async () => {
    const broadcasted = []
    const fallbacks = []
    const store = { getSetting() { return null } }

    const queryImpl = () => {
      async function* run() {
        throw new Error('Claude Code returned an error result: No conversation found with session ID: abc123')
      }
      const it = run()
      it.interrupt = async () => {}
      it.close = async () => {}
      return it
    }

    const driver = createClaudeSdkDriver({
      store,
      claudeBroadcast: (_cs, event) => { broadcasted.push(event) },
      rerunTurn: () => {},
      runCliFallback: (...args) => { fallbacks.push(args) },
      queryImpl,
    })
    const cs = {
      claudeSessionId: 'abc123', busy: false, turnCount: 1,
      explicitSessionId: true, queue: [], history: [], clients: new Set(),
    }
    await driver.runSdkTurn(cs, 'hi', 'p:claude:t', '/tmp')
    // Let setImmediate fire (the CLI fallback is dispatched via setImmediate)
    await new Promise((resolve) => setImmediate(resolve))

    // Resume-miss → CLI fallback IS triggered
    assert.equal(fallbacks.length, 1, 'CLI fallback must be triggered for resume-miss errors')
  })
})
