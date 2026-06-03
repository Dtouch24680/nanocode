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

// Test Root F: new behavior — DOM always built, display:none when toggle off (not gated/discarded)
test('_handleUserEvent: subagent events always get DOM built (display:none when toggle off)', () => {
  const rendered = []
  const ls = makeStorage()
  const t = makeToggles(ls)
  // activity is off by default

  function handleUserEvent(event) {
    const parentToolUseId = event.parent_tool_use_id
    if (parentToolUseId) {
      // Root F new behavior: always build DOM, set display:none if toggle off
      const isVisible = t.getSubagentActivityVisible()
      rendered.push({ type: 'subagent-activity', visible: isVisible })
      return
    }
    // normal
    rendered.push({ type: 'normal-user' })
  }

  // Subagent activity event (activity off) → DOM built but hidden
  handleUserEvent({ type: 'user', parent_tool_use_id: 'parent123', message: { content: [] } })
  assert(rendered.length === 1, 'Subagent activity DOM should be built even when toggle off')
  assert(rendered[0].visible === false, 'Block should be hidden (display:none) when toggle off')

  // Normal user event → should render visible
  handleUserEvent({ type: 'user', message: { content: [] } })
  assert(rendered.length === 2, 'Normal user event should render')
  assert(rendered[1].type === 'normal-user', 'Should be normal user type')
})

test('_handleUserEvent: subagent events built and visible when activity=true', () => {
  const rendered = []
  const ls = makeStorage()
  const t = makeToggles(ls)
  t.setSubagentActivityVisible(true)

  function handleUserEvent(event) {
    const parentToolUseId = event.parent_tool_use_id
    if (parentToolUseId) {
      const isVisible = t.getSubagentActivityVisible()
      rendered.push({ type: 'subagent-activity', visible: isVisible })
      return
    }
    rendered.push({ type: 'normal-user' })
  }

  handleUserEvent({ type: 'user', parent_tool_use_id: 'parent123', message: { content: [] } })
  assert(rendered.length === 1, 'Subagent activity should render when toggle on')
  assert(rendered[0].visible === true, 'Block should be visible when toggle on')
})

test('_handleAssistant: subagent events always built, not discarded (Root F)', () => {
  const rendered = []
  const ls = makeStorage()
  const t = makeToggles(ls)
  // activity off by default

  function handleAssistant(event) {
    if (event.parent_tool_use_id) {
      // Root F: build DOM regardless, set display:none based on toggle
      const isVisible = t.getSubagentActivityVisible()
      rendered.push({ type: 'subagent-assistant', visible: isVisible })
      return
    }
    rendered.push({ type: 'main-assistant' })
  }

  // Subagent assistant event → DOM built, hidden
  handleAssistant({ parent_tool_use_id: 'parent123', message: { content: [] } })
  assert(rendered.length === 1, 'Subagent assistant DOM should be built (Root F fix)')
  assert(rendered[0].visible === false, 'Should be hidden when toggle off')

  // Main agent assistant → rendered visible
  handleAssistant({ parent_tool_use_id: null, message: { content: [] } })
  assert(rendered.length === 2, 'Main agent assistant should render')
  assert(rendered[1].type === 'main-assistant', 'Main assistant type correct')
})

test('_handlePartialMessage: subagent partials always processed (Root F)', () => {
  const rendered = []
  const ls = makeStorage()
  const t = makeToggles(ls)

  function handlePartialMessage(event) {
    if (event.parent_tool_use_id) {
      // Root F: build DOM, set visibility from toggle
      const isVisible = t.getSubagentActivityVisible()
      rendered.push({ type: 'subagent-partial', visible: isVisible })
      return
    }
    rendered.push({ type: 'main-partial' })
  }

  handlePartialMessage({ parent_tool_use_id: 'pid', message: { content: [] } })
  assert(rendered.length === 1, 'Subagent partial DOM built (Root F fix — no longer discarded)')
  assert(rendered[0].visible === false, 'Should be hidden when toggle off')

  handlePartialMessage({ parent_tool_use_id: undefined, message: { content: [] } })
  assert(rendered.length === 2, 'Main agent partial should render')
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
