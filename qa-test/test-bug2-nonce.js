// Unit test: Bug2 — nonce dedup + reconnect history replay
// Simulates the _handleUserEvent logic from claude-block-renderer.js

let passed = 0
let failed = 0

function test(name, fn) {
  try {
    fn()
    console.log(`PASS: ${name}`)
    passed++
  } catch (e) {
    console.log(`FAIL: ${name} — ${e.message}`)
    failed++
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed')
}

// Simulate the ClaudeBlockRenderer's nonce + user event handling
function makeRenderer() {
  const rendered = []
  const _pendingNonces = new Set()

  function sendInputWithEcho(text) {
    const nonce = 'nonce-' + Math.random().toString(36).slice(2)
    _pendingNonces.add(nonce)
    rendered.push({ type: 'local-echo', text })
    return nonce
  }

  function handleUserEvent(event) {
    // Exact logic from claude-block-renderer.js _handleUserEvent
    const nonce = event._nonce
    if (nonce && _pendingNonces.has(nonce)) {
      _pendingNonces.delete(nonce)
      return // dedup
    }

    const content = event.message?.content
    if (!Array.isArray(content)) return

    // No parent_tool_use_id for basic user turns
    for (const c of content) {
      if (c.type === 'text' && c.text?.trim()) {
        rendered.push({ type: 'user-block', text: c.text })
      } else if (c.type === 'tool_result') {
        rendered.push({ type: 'tool-result', content: c.content })
      }
    }
  }

  return { sendInputWithEcho, handleUserEvent, rendered, _pendingNonces }
}

// Test 1: Local echo + server broadcast with nonce → no double render
test('Nonce dedup: local echo + server broadcast = exactly 1 render', () => {
  const r = makeRenderer()
  const nonce = r.sendInputWithEcho('hello')
  // Server broadcasts back the same event with the nonce
  r.handleUserEvent({
    type: 'user',
    _nonce: nonce,
    message: { role: 'user', content: [{ type: 'text', text: 'hello' }] }
  })
  // Should have only 1 render (local echo), not 2
  const userBlocks = r.rendered.filter(b => b.type === 'user-block')
  assert(userBlocks.length === 0, `Expected 0 user-block (deduped), got ${userBlocks.length}`)
  const localEchos = r.rendered.filter(b => b.type === 'local-echo')
  assert(localEchos.length === 1, `Expected 1 local-echo, got ${localEchos.length}`)
})

// Test 2: History replay (no nonce) → renders
test('History replay without nonce: message is rendered', () => {
  const r = makeRenderer()
  // On reconnect, server replays history without nonce
  r.handleUserEvent({
    type: 'user',
    _nonce: null,
    message: { role: 'user', content: [{ type: 'text', text: 'hello' }] }
  })
  const userBlocks = r.rendered.filter(b => b.type === 'user-block')
  assert(userBlocks.length === 1, `Expected 1 user-block, got ${userBlocks.length}`)
})

// Test 3: Two different messages → both render
test('Two distinct history replays → 2 blocks rendered', () => {
  const r = makeRenderer()
  r.handleUserEvent({
    type: 'user',
    _nonce: null,
    message: { role: 'user', content: [{ type: 'text', text: 'msg1' }] }
  })
  r.handleUserEvent({
    type: 'user',
    _nonce: null,
    message: { role: 'user', content: [{ type: 'text', text: 'msg2' }] }
  })
  const userBlocks = r.rendered.filter(b => b.type === 'user-block')
  assert(userBlocks.length === 2, `Expected 2 user-blocks, got ${userBlocks.length}`)
})

// Test 4: tool_result in user event → rendered
test('tool_result in user event renders tool output', () => {
  const r = makeRenderer()
  r.handleUserEvent({
    type: 'user',
    _nonce: null,
    message: {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'id1', content: 'some output here' }
      ]
    }
  })
  const toolResults = r.rendered.filter(b => b.type === 'tool-result')
  assert(toolResults.length === 1, `Expected 1 tool-result, got ${toolResults.length}`)
  assert(toolResults[0].content === 'some output here', 'tool_result content mismatch')
})

// Test 5: Reconnect — _pendingNonces cleared → no ghost dedup
test('After reconnect (pendingNonces cleared), old nonce does not dedup new event', () => {
  const r = makeRenderer()
  const nonce = r.sendInputWithEcho('msg before reconnect')
  // Simulate reconnect: clear nonces
  r._pendingNonces.clear()
  // Server replays history with the old nonce (replay from history with nonce)
  r.handleUserEvent({
    type: 'user',
    _nonce: nonce, // old nonce — but it's been cleared
    message: { role: 'user', content: [{ type: 'text', text: 'msg before reconnect' }] }
  })
  const userBlocks = r.rendered.filter(b => b.type === 'user-block')
  assert(userBlocks.length === 1, `Expected 1 user-block (nonce cleared on reconnect), got ${userBlocks.length}`)
})

// Test 6: Server stores user event in cs.history (routes.js test)
test('routes.js: claudeBroadcast stores event in history', () => {
  // Simulate claudeBroadcast behavior
  const cs = { history: [], clients: new Set() }
  function claudeBroadcast(cs, event) {
    cs.history.push(event)
    if (cs.history.length > 500) cs.history.shift()
  }
  const userEvent = {
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    _nonce: 'abc123'
  }
  claudeBroadcast(cs, userEvent)
  assert(cs.history.length === 1, 'Expected 1 event in history')
  assert(cs.history[0]._nonce === 'abc123', 'nonce should be in history')
  assert(cs.history[0].type === 'user', 'type should be user')
})

console.log(`\nResults: PASS=${passed} FAIL=${failed}`)
process.exit(failed > 0 ? 1 : 0)
