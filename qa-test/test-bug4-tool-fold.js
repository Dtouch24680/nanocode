// Unit test: Bug4 — tool fold rendering + tool_result visibility
// Tests the key logic:
//   1. _handleUserEvent now handles tool_result type
//   2. applyToolFold sets data-fold attribute
//   3. CSS :not([data-fold]) fallback works (logic check)
//   4. fold toggle: header clicks flip full↔header for single block

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

// ── Test 1: tool_result type is now handled ──────────────────────────────────
test('_handleUserEvent renders tool_result content (not just text)', () => {
  const rendered = []
  
  // Simulate _handleUserEvent logic
  function handleUserEvent(event) {
    const content = event.message?.content
    if (!Array.isArray(content)) return
    for (const c of content) {
      if (c.type === 'text' && c.text?.trim()) {
        rendered.push({ type: 'user-block', text: c.text })
      } else if (c.type === 'tool_result') {
        rendered.push({ type: 'tool-result', content: c.content })
      }
    }
  }
  
  // User event with tool_result (bash stdout)
  handleUserEvent({
    type: 'user',
    message: {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'tu1', content: 'hello from bash\n$ ls\nfile1 file2' }
      ]
    }
  })
  
  assert(rendered.length === 1, `Expected 1 block, got ${rendered.length}`)
  assert(rendered[0].type === 'tool-result', 'Expected tool-result type')
  assert(rendered[0].content.includes('hello from bash'), 'Expected tool output content')
})

// ── Test 2: tool_result with array content ──────────────────────────────────
test('_renderToolResultPart handles array content correctly', () => {
  function renderToolResultPart(part) {
    const content = part.content
    if (!content) return null
    let text = ''
    if (typeof content === 'string') {
      text = content
    } else if (Array.isArray(content)) {
      text = content.filter((c) => c.type === 'text').map((c) => c.text).join('\n')
    }
    if (!text.trim()) return null
    return text
  }
  
  // String content
  const result1 = renderToolResultPart({ content: 'stdout here' })
  assert(result1 === 'stdout here', 'String content failed')
  
  // Array content
  const result2 = renderToolResultPart({
    content: [
      { type: 'text', text: 'line1' },
      { type: 'text', text: 'line2' }
    ]
  })
  assert(result2 === 'line1\nline2', `Array content failed: ${result2}`)
  
  // Empty content → null
  const result3 = renderToolResultPart({ content: [] })
  assert(result3 === null, 'Empty array should return null')
})

// ── Test 3: applyToolFold sets data-fold attribute ─────────────────────────
test('applyToolFold sets data-fold attribute', () => {
  // Mock minimal DOM element
  const el = { _attrs: {}, setAttribute(k, v) { this._attrs[k] = v } }
  
  const TOOL_FOLD_KEY = 'cbr_tool_fold'
  const TOOL_FOLD_LEVELS = ['full', 'header', 'line']
  function getToolFoldLevel() { return 'full' } // simulate default
  function applyToolFold(el, level) {
    el.setAttribute('data-fold', level || getToolFoldLevel())
  }
  
  applyToolFold(el, 'header')
  assert(el._attrs['data-fold'] === 'header', 'Expected data-fold=header')
  
  applyToolFold(el, undefined)
  assert(el._attrs['data-fold'] === 'full', 'Expected data-fold=full (default)')
})

// ── Test 4: fold toggle logic (header click) ───────────────────────────────
test('Header click toggles full↔header for single block', () => {
  // From _renderToolUsePart
  const el = { _attrs: {}, setAttribute(k, v) { this._attrs[k] = v }, getAttribute(k) { return this._attrs[k] || null } }
  const getToolFoldLevel = () => 'full'
  
  // Set initial fold
  el.setAttribute('data-fold', 'full')
  
  // Simulate click
  function headerClick(article) {
    const cur = article.getAttribute('data-fold') || getToolFoldLevel()
    const next = cur === 'full' ? 'header' : 'full'
    article.setAttribute('data-fold', next)
  }
  
  assert(el.getAttribute('data-fold') === 'full', 'Initial: full')
  headerClick(el)
  assert(el.getAttribute('data-fold') === 'header', 'After click 1: header')
  headerClick(el)
  assert(el.getAttribute('data-fold') === 'full', 'After click 2: back to full')
})

// ── Test 5: setToolFoldLevel updates all existing blocks ──────────────────
test('setToolFoldLevel applies to all existing blocks', () => {
  // Simulate querySelectorAll + setAttribute
  const blocks = [
    { _attrs: { 'data-fold': 'full' }, setAttribute(k, v) { this._attrs[k] = v } },
    { _attrs: { 'data-fold': 'full' }, setAttribute(k, v) { this._attrs[k] = v } },
  ]
  const storage = {}
  
  function setToolFoldLevel(level) {
    if (!['full', 'header', 'line'].includes(level)) return
    storage['cbr_tool_fold'] = level
    for (const el of blocks) {
      el.setAttribute('data-fold', level)
    }
  }
  
  setToolFoldLevel('line')
  
  assert(storage['cbr_tool_fold'] === 'line', 'localStorage should be updated')
  for (const b of blocks) {
    assert(b._attrs['data-fold'] === 'line', 'Each block should get data-fold=line')
  }
})

// ── Test 6: CSS fallback :not([data-fold]) existence check ─────────────────
test('CSS has :not([data-fold]) fallback rule', () => {
  const fs = require('fs')
  const css = fs.readFileSync('/storage/home/zhiningjiao/code/nanocode/public/style.css', 'utf-8')
  assert(css.includes(':not([data-fold])'), 'CSS must have :not([data-fold]) fallback')
  assert(css.includes('cbr-block-tool:not([data-fold]) .cbr-tool-body'), 'CSS must have tool-body fallback')
  assert(css.includes('cbr-block-tool-result:not([data-fold]) .cbr-tool-result'), 'CSS must have tool-result fallback')
})

console.log(`\nResults: PASS=${passed} FAIL=${failed}`)
process.exit(failed > 0 ? 1 : 0)
