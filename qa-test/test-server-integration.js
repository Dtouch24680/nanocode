// Integration tests against the running test server at :3099

import { createServer } from 'http'
import { WebSocket } from 'ws'

const BASE = 'http://localhost:3099'
const WS_BASE = 'ws://localhost:3099'

let passed = 0
let failed = 0

async function test(name, fn) {
  try {
    await fn()
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

async function fetchJson(path, opts = {}) {
  const res = await fetch(`${BASE}${path}`, opts)
  const body = await res.text()
  try { return { status: res.status, data: JSON.parse(body) } }
  catch { return { status: res.status, data: body } }
}

// Test 1: Health check
await test('Health: GET /api/health → 200 ok', async () => {
  const r = await fetchJson('/api/health')
  assert(r.status === 200, `Expected 200, got ${r.status}`)
  assert(r.data.status === 'ok', `Expected status ok, got ${JSON.stringify(r.data)}`)
})

// Test 2: Settings GET
await test('Settings: GET /api/settings returns settings object', async () => {
  const r = await fetchJson('/api/settings')
  assert(r.status === 200, `Expected 200, got ${r.status}`)
  assert(typeof r.data === 'object', 'Expected object')
})

// Test 3: Settings PUT round-trip
await test('Settings: PUT /api/settings → stores and retrieves value', async () => {
  // Save autoresume=0
  const putR = await fetchJson('/api/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: 'claude_autoresume', value: '0' }),
  })
  assert(putR.data.ok === true, 'PUT should return ok')
  
  const getR = await fetchJson('/api/settings')
  assert(getR.data.claude_autoresume === '0', 'Setting should be persisted')
  
  // Restore
  await fetchJson('/api/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: 'claude_autoresume', value: '1' }),
  })
})

// Test 4: Create project + list tabs API
await test('Projects: POST + GET tabs', async () => {
  const proj = await fetchJson('/api/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'QA-Test', cwd: '/tmp' }),
  })
  assert(proj.status === 201, `Expected 201, got ${proj.status}`)
  const projectId = proj.data.id
  
  const tabs = await fetchJson(`/api/projects/${projectId}/tabs`)
  assert(tabs.status === 200, 'Expected tabs 200')
  assert(Array.isArray(tabs.data), 'Expected array of tabs')
  
  // Create a claude tab
  const tab = await fetchJson(`/api/projects/${projectId}/tabs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ label: 'claude', type: 'claude' }),
  })
  assert(tab.status === 201, `Expected tab 201, got ${tab.status}`)
  assert(tab.data.type === 'claude', 'Expected type=claude')
  
  // Cleanup
  await fetchJson(`/api/projects/${projectId}`, { method: 'DELETE' })
})

// Test 5: WS tab subscription (tabs WebSocket)
await test('WebSocket: tabs subscription sends snapshot', async () => {
  // First create a project
  const proj = await fetchJson('/api/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'WS-QA', cwd: '/tmp' }),
  })
  const projectId = proj.data.id
  
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS_BASE}/ws/tabs`)
    const timeout = setTimeout(() => {
      ws.close()
      reject(new Error('WS subscription timeout'))
    }, 3000)
    
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'subscribe', projectId }))
    })
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString())
      if (msg.type === 'tabs:update') {
        clearTimeout(timeout)
        ws.close()
        resolve()
      }
    })
    ws.on('error', (e) => { clearTimeout(timeout); reject(e) })
  })
  
  // Cleanup
  await fetchJson(`/api/projects/${projectId}`, { method: 'DELETE' })
})

console.log(`\nResults: PASS=${passed} FAIL=${failed}`)
process.exit(failed > 0 ? 1 : 0)
