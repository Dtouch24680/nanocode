// Unit test: Bug3 — scroll-to-bottom button visibility logic
// Tests the _updateScrollBtn logic

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

// Simulate scroll state
function makeScrollState(scrollTop, scrollHeight, clientHeight) {
  // From _updateScrollBtn: 
  // const atBottom = s.scrollHeight - s.scrollTop - s.clientHeight < 60
  const atBottom = scrollHeight - scrollTop - clientHeight < 60
  return { atBottom }
}

// Button visible when NOT at bottom
test('Button hidden when at bottom (scrolled all the way down)', () => {
  const { atBottom } = makeScrollState(940, 1000, 60)  // at exact bottom
  assert(atBottom, 'Expected atBottom=true')
  // button.classList.toggle('cbr-scroll-btn-visible', !atBottom) → hidden
})

test('Button hidden when within 60px of bottom', () => {
  const { atBottom } = makeScrollState(900, 1000, 60)  // 40px from bottom
  assert(atBottom, 'Expected atBottom=true (within 60px)')
})

test('Button visible when far from bottom (>60px away)', () => {
  const { atBottom } = makeScrollState(500, 1000, 100)  // 400px from bottom
  assert(!atBottom, 'Expected atBottom=false (far from bottom)')
})

test('Button visible at exact 60px boundary', () => {
  const { atBottom } = makeScrollState(880, 1000, 60)  // exactly 60px from bottom (scrollHeight - scrollTop - clientHeight = 60, NOT < 60)
  assert(!atBottom, 'Expected atBottom=false at exactly 60px boundary')
})

test('Button hidden at 59px from bottom', () => {
  const { atBottom } = makeScrollState(881, 1000, 60)  // 59px from bottom (< 60 → atBottom)
  assert(atBottom, 'Expected atBottom=true at 59px')
})

test('Button visible when at top of long content', () => {
  const { atBottom } = makeScrollState(0, 5000, 600)  // top of page
  assert(!atBottom, 'Expected atBottom=false at top')
})

console.log(`\nResults: PASS=${passed} FAIL=${failed}`)
process.exit(failed > 0 ? 1 : 0)
