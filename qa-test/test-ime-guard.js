// Unit test: IME composition guard logic from terminal-view.js
// We extract the exact guard condition and test it with simulated events

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

// Simulated state + handler
function makeHandler() {
  let _isComposing = false
  let lastSent = null

  function compositionStart() { _isComposing = true }
  function compositionEnd() { _isComposing = false }

  function handleKeydown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      // Exact guard from terminal-view.js line 533
      if (e.isComposing || _isComposing || e.keyCode === 229) return
      lastSent = e.value || 'SENT'
    }
  }

  return { compositionStart, compositionEnd, handleKeydown, getSent: () => lastSent }
}

// Test 1: Normal Enter → sends
test('Normal Enter sends', () => {
  const h = makeHandler()
  h.handleKeydown({ key: 'Enter', shiftKey: false, isComposing: false, keyCode: 13 })
  assert(h.getSent() !== null, 'Expected send')
})

// Test 2: Enter during e.isComposing → does NOT send
test('Enter during e.isComposing does not send', () => {
  const h = makeHandler()
  h.handleKeydown({ key: 'Enter', shiftKey: false, isComposing: true, keyCode: 13 })
  assert(h.getSent() === null, 'Expected no send during isComposing')
})

// Test 3: Enter during _isComposing flag → does NOT send
test('Enter during compositionstart flag does not send', () => {
  const h = makeHandler()
  h.compositionStart()
  h.handleKeydown({ key: 'Enter', shiftKey: false, isComposing: false, keyCode: 13 })
  assert(h.getSent() === null, 'Expected no send during composition flag')
})

// Test 4: Enter after compositionEnd → sends
test('Enter after compositionEnd sends', () => {
  const h = makeHandler()
  h.compositionStart()
  h.compositionEnd()
  h.handleKeydown({ key: 'Enter', shiftKey: false, isComposing: false, keyCode: 13 })
  assert(h.getSent() !== null, 'Expected send after compositionEnd')
})

// Test 5: keyCode 229 (legacy browser) → does NOT send
test('keyCode 229 (legacy IME) does not send', () => {
  const h = makeHandler()
  h.handleKeydown({ key: 'Enter', shiftKey: false, isComposing: false, keyCode: 229 })
  assert(h.getSent() === null, 'Expected no send with keyCode 229')
})

// Test 6: Shift+Enter → does NOT send (should allow newline)
test('Shift+Enter does not send (newline)', () => {
  const h = makeHandler()
  h.handleKeydown({ key: 'Enter', shiftKey: true, isComposing: false, keyCode: 13 })
  assert(h.getSent() === null, 'Expected no send for Shift+Enter')
})

console.log(`\nResults: PASS=${passed} FAIL=${failed}`)
process.exit(failed > 0 ? 1 : 0)
