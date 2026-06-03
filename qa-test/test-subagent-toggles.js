// Unit test: Subagent visibility toggles (Item 6)
// Tests the logic from claude-block-renderer.js

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

// Mock localStorage
function makeStorage() {
  const store = {}
  return {
    getItem: (k) => k in store ? store[k] : null,
    setItem: (k, v) => { store[k] = v },
    data: store
  }
}

// Simulate the toggle logic
function makeToggles(ls) {
  function getSubagentPromptVisible() {
    const v = ls.getItem('cbr_subagent_prompt')
    return v === null ? true : v !== 'false'
  }
  function getSubagentActivityVisible() {
    const v = ls.getItem('cbr_subagent_activity')
    return v === null ? false : v === 'true'
  }
  function setSubagentPromptVisible(val) {
    ls.setItem('cbr_subagent_prompt', val ? 'true' : 'false')
  }
  function setSubagentActivityVisible(val) {
    ls.setItem('cbr_subagent_activity', val ? 'true' : 'false')
  }
  return { getSubagentPromptVisible, getSubagentActivityVisible, setSubagentPromptVisible, setSubagentActivityVisible }
}

// Test defaults
test('Default: subagent prompt visible (true)', () => {
  const ls = makeStorage()
  const t = makeToggles(ls)
  assert(t.getSubagentPromptVisible() === true, 'Expected default=true for prompt')
})

test('Default: subagent activity hidden (false)', () => {
  const ls = makeStorage()
  const t = makeToggles(ls)
  assert(t.getSubagentActivityVisible() === false, 'Expected default=false for activity')
})

// Test setting toggles
test('Set prompt to false → getSubagentPromptVisible() returns false', () => {
  const ls = makeStorage()
  const t = makeToggles(ls)
  t.setSubagentPromptVisible(false)
  assert(t.getSubagentPromptVisible() === false, 'Expected false after setting')
})

test('Set activity to true → getSubagentActivityVisible() returns true', () => {
  const ls = makeStorage()
  const t = makeToggles(ls)
  t.setSubagentActivityVisible(true)
  assert(t.getSubagentActivityVisible() === true, 'Expected true after setting')
})

// Test event gating logic
test('_handleUserEvent gates parent_tool_use_id events when activity=false', () => {
  const rendered = []
  const ls = makeStorage()
  const t = makeToggles(ls)
  // activity is off by default
  
  function handleUserEvent(event) {
    const parentToolUseId = event.parent_tool_use_id
    if (parentToolUseId) {
      if (!t.getSubagentActivityVisible()) return // gate
      rendered.push({ type: 'subagent-activity' })
      return
    }
    // normal
    rendered.push({ type: 'normal-user' })
  }
  
  // Subagent activity event (activity off) → should be gated
  handleUserEvent({ type: 'user', parent_tool_use_id: 'parent123', message: { content: [] } })
  assert(rendered.length === 0, 'Subagent activity should be gated when toggle off')
  
  // Normal user event → should render
  handleUserEvent({ type: 'user', message: { content: [] } })
  assert(rendered.length === 1, 'Normal user event should render')
})

test('_handleUserEvent shows subagent events when activity=true', () => {
  const rendered = []
  const ls = makeStorage()
  const t = makeToggles(ls)
  t.setSubagentActivityVisible(true)
  
  function handleUserEvent(event) {
    const parentToolUseId = event.parent_tool_use_id
    if (parentToolUseId) {
      if (!t.getSubagentActivityVisible()) return
      rendered.push({ type: 'subagent-activity' })
      return
    }
    rendered.push({ type: 'normal-user' })
  }
  
  handleUserEvent({ type: 'user', parent_tool_use_id: 'parent123', message: { content: [] } })
  assert(rendered.length === 1, 'Subagent activity should render when toggle on')
})

test('_handleAssistant gates parent_tool_use_id events when activity=false', () => {
  const rendered = []
  const ls = makeStorage()
  const t = makeToggles(ls)
  // activity off by default
  
  function handleAssistant(event) {
    if (event.parent_tool_use_id && !t.getSubagentActivityVisible()) return
    rendered.push({ type: 'assistant' })
  }
  
  // Subagent assistant event → gated
  handleAssistant({ parent_tool_use_id: 'parent123', message: { content: [] } })
  assert(rendered.length === 0, 'Subagent assistant should be gated')
  
  // Main agent assistant → rendered
  handleAssistant({ parent_tool_use_id: null, message: { content: [] } })
  assert(rendered.length === 1, 'Main agent assistant should render')
})

test('_handlePartialMessage gates subagent partials when activity=false', () => {
  const rendered = []
  const ls = makeStorage()
  const t = makeToggles(ls)
  
  function handlePartialMessage(event) {
    if (event.parent_tool_use_id && !t.getSubagentActivityVisible()) return
    rendered.push({ type: 'partial' })
  }
  
  handlePartialMessage({ parent_tool_use_id: 'pid', message: { content: [] } })
  assert(rendered.length === 0, 'Subagent partial should be gated')
  
  handlePartialMessage({ parent_tool_use_id: undefined, message: { content: [] } })
  assert(rendered.length === 1, 'Main agent partial should render')
})

// Test subagent-prompt toggle gates Agent/Task tool_use blocks
test('Subagent prompt blocks hidden when prompt toggle off', () => {
  const ls = makeStorage()
  const t = makeToggles(ls)
  t.setSubagentPromptVisible(false)
  
  function shouldShowToolBlock(part) {
    const isSubagentTool = part.name === 'Agent' || part.name === 'Task' || part.name === 'TaskCreate'
    const isBashCodexDispatch = part.name === 'Bash' && (
      typeof part.input?.command === 'string' && /codex|dispatch.codex/i.test(part.input.command)
    )
    const isSubagentPrompt = isSubagentTool || isBashCodexDispatch
    if (isSubagentPrompt && !t.getSubagentPromptVisible()) return false
    return true
  }
  
  assert(!shouldShowToolBlock({ name: 'Agent', input: { prompt: 'do x' } }), 'Agent tool hidden when prompt off')
  assert(!shouldShowToolBlock({ name: 'Task', input: {} }), 'Task tool hidden when prompt off')
  assert(shouldShowToolBlock({ name: 'Bash', input: { command: 'ls' } }), 'Normal Bash tool shown')
  assert(!shouldShowToolBlock({ name: 'Bash', input: { command: 'codex --apply ...' } }), 'Codex dispatch hidden')
})

console.log(`\nResults: PASS=${passed} FAIL=${failed}`)
process.exit(failed > 0 ? 1 : 0)
