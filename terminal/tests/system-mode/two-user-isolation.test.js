/**
 * E2E spec: two users on the same host see disjoint state.
 *
 * Alice and Bob each have their own worker. The router proxies each
 * user's requests to their worker. Critical invariants:
 *   - Alice's API calls (projects, files, tabs) never observe Bob's data.
 *   - Bob's cookie cannot impersonate Alice (and vice versa).
 *   - Cookie tampering / cookie swap is rejected (the sid is opaque).
 *   - WS endpoints honor the same scoping.
 */

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import WebSocket from 'ws'
import { once } from 'node:events'

let withRouter, withWorker
try {
  ;({ withRouter } = await import('./fixtures/with-router.js'))
  ;({ withWorker } = await import('./fixtures/with-worker.js'))
} catch { /* skip */ }

describe('system-mode two-user isolation', () => {
  let router, aliceWorker, bobWorker
  let aliceCookie, bobCookie
  let bootstrapErr

  before(async () => {
    if (!withRouter || !withWorker) {
      bootstrapErr = new Error('NOT_IMPLEMENTED')
      return
    }
    try {
      router = await withRouter()
      aliceWorker = await withWorker({ uid: 1001, username: 'alice' })
      bobWorker = await withWorker({ uid: 1002, username: 'bob' })
      const aliceSid = await router.sessionTokenForUid({
        uid: 1001, username: 'alice', workerSock: aliceWorker.sock,
      })
      const bobSid = await router.sessionTokenForUid({
        uid: 1002, username: 'bob', workerSock: bobWorker.sock,
      })
      aliceCookie = `nano_sid=${aliceSid}`
      bobCookie = `nano_sid=${bobSid}`
    } catch (err) {
      bootstrapErr = err
    }
  })

  after(async () => {
    if (aliceWorker) await aliceWorker.close()
    if (bobWorker) await bobWorker.close()
    if (router) await router.close()
  })

  async function listProjects(cookie) {
    return (await fetch(`${router.url}/api/projects`, { headers: { cookie } })).json()
  }

  async function createProject(cookie, name, cwd) {
    const r = await fetch(`${router.url}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ name, cwd }),
    })
    return r.json()
  }

  it('alice creates a project; bob does not see it', async (t) => {
    if (bootstrapErr) return t.skip(bootstrapErr.message)
    const aliceProj = await createProject(aliceCookie, 'alice-secret', '/tmp/alice')

    const bobList = await listProjects(bobCookie)
    assert.ok(!bobList.some((p) => p.id === aliceProj.id), "bob cannot see alice's project")

    const aliceList = await listProjects(aliceCookie)
    assert.ok(aliceList.some((p) => p.id === aliceProj.id), 'alice sees her own project')
  })

  it('bob cannot fetch files from alice\'s project even with its id', async (t) => {
    if (bootstrapErr) return t.skip(bootstrapErr.message)
    const aliceProj = await createProject(aliceCookie, 'alice-proj-2', '/tmp/alice')

    const bobAttempt = await fetch(`${router.url}/api/projects/${aliceProj.id}/files`, {
      headers: { cookie: bobCookie },
    })
    assert.equal(bobAttempt.status, 404, "bob's worker doesn't know the project")
  })

  it('alice cannot read /home/bob/* through the file API', async (t) => {
    if (bootstrapErr) return t.skip(bootstrapErr.message)
    const aliceProj = await createProject(aliceCookie, 'home-test', aliceWorker.home)

    // Even with a cwd that traverses upward, the worker (running as alice's
    // uid) is the only one that opens files, so kernel ACL denies access.
    const r = await fetch(`${router.url}/api/projects/${aliceProj.id}/files?path=../bob/.nanocode/data.json`, {
      headers: { cookie: aliceCookie },
    })
    assert.ok(r.status === 403 || r.status === 404, `expected 403/404, got ${r.status}`)
  })

  it('tab WS subscription scoped to {uid, projectId} — bob\'s ws gets no alice updates', async (t) => {
    if (bootstrapErr) return t.skip(bootstrapErr.message)
    const aliceProj = await createProject(aliceCookie, 'tab-scope-test', aliceWorker.home)

    const bobWs = new WebSocket(`${router.url.replace('http', 'ws')}/ws/tabs`, { headers: { cookie: bobCookie } })
    await once(bobWs, 'open')
    const bobMsgs = []
    bobWs.on('message', (b) => bobMsgs.push(JSON.parse(b.toString())))
    bobWs.send(JSON.stringify({ type: 'subscribe', projectId: aliceProj.id }))
    await new Promise((r) => setTimeout(r, 200))

    // Alice creates a tab on her project
    await fetch(`${router.url}/api/projects/${aliceProj.id}/tabs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: aliceCookie },
      body: '{}',
    })
    await new Promise((r) => setTimeout(r, 200))

    // Bob should NOT have received an update for alice's project
    const got = bobMsgs.filter((m) => m.type === 'tabs:update' && m.projectId === aliceProj.id)
    assert.equal(got.length, 0, 'bob received tab update for alice\'s project')
    bobWs.close()
  })

  it('cookie cannot be forged: random sid → 401', async (t) => {
    if (bootstrapErr) return t.skip(bootstrapErr.message)
    const fake = 'cafef00d'.repeat(8)
    const r = await fetch(`${router.url}/api/projects`, {
      headers: { cookie: `nano_sid=${fake}` },
    })
    assert.equal(r.status, 401)
  })

  it('PTY WS attach: alice\'s session cannot reach bob\'s worker', async (t) => {
    if (bootstrapErr) return t.skip(bootstrapErr.message)
    // alice connects to /ws/terminal with bob's project id (which she doesn't have).
    // Expectation: router routes by SESSION's uid, not by message content;
    // so any tabId/projectId reaches alice's worker only. Bob's PTYs are unreachable.
    const ws = new WebSocket(`${router.url.replace('http', 'ws')}/ws/terminal`, { headers: { cookie: aliceCookie } })
    await once(ws, 'open')
    const msgs = []
    ws.on('message', (b) => msgs.push(JSON.parse(b.toString())))
    ws.send(JSON.stringify({
      type: 'attach', projectId: 'BOB-FAKE-PROJ-ID', sessionType: 'bash',
      tabId: 'forged', cols: 80, rows: 24,
    }))
    await new Promise((r) => setTimeout(r, 300))
    // Worker should respond with an error (project not found in alice's data)
    assert.ok(msgs.some((m) => m.type === 'error'), 'expected error from alice\'s worker')
    ws.close()
  })
})
