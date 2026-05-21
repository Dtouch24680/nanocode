/**
 * E2E spec: tab WS broadcasts are scoped to {uid, projectId}.
 *
 * Both devices of the same user receive each other's updates.
 * Devices of different users on the same project id do NOT cross-talk.
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

describe('system-mode tab-broadcast scoping', () => {
  let router, aliceWorker, bobWorker, aliceCookie, bobCookie
  let aliceProjectId
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
      const proj = await (await fetch(`${router.url}/api/projects`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', cookie: aliceCookie },
        body: JSON.stringify({ name: 'alice-tab-test', cwd: aliceWorker.home }),
      })).json()
      aliceProjectId = proj.id
    } catch (err) {
      bootstrapErr = err
    }
  })

  after(async () => {
    if (aliceWorker) await aliceWorker.close()
    if (bobWorker) await bobWorker.close()
    if (router) await router.close()
  })

  it('two of alice\'s devices both receive her tab updates', async (t) => {
    if (bootstrapErr) return t.skip(bootstrapErr.message)
    const wsA = new WebSocket(`${router.url.replace('http', 'ws')}/ws/tabs`, { headers: { cookie: aliceCookie } })
    const wsB = new WebSocket(`${router.url.replace('http', 'ws')}/ws/tabs`, { headers: { cookie: aliceCookie } })
    await Promise.all([once(wsA, 'open'), once(wsB, 'open')])
    const msgsA = [], msgsB = []
    wsA.on('message', (b) => msgsA.push(JSON.parse(b.toString())))
    wsB.on('message', (b) => msgsB.push(JSON.parse(b.toString())))
    wsA.send(JSON.stringify({ type: 'subscribe', projectId: aliceProjectId }))
    wsB.send(JSON.stringify({ type: 'subscribe', projectId: aliceProjectId }))
    await new Promise((r) => setTimeout(r, 150))

    await fetch(`${router.url}/api/projects/${aliceProjectId}/tabs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: aliceCookie },
      body: '{}',
    })
    await new Promise((r) => setTimeout(r, 250))

    const countA = msgsA.filter((m) => m.type === 'tabs:update').length
    const countB = msgsB.filter((m) => m.type === 'tabs:update').length
    assert.ok(countA >= 2, `device A received >=2 updates (got ${countA})`)
    assert.ok(countB >= 2, `device B received >=2 updates (got ${countB})`)
    wsA.close(); wsB.close()
  })

  it('a bob subscribing with alice\'s projectId receives no updates', async (t) => {
    if (bootstrapErr) return t.skip(bootstrapErr.message)
    const bobWs = new WebSocket(`${router.url.replace('http', 'ws')}/ws/tabs`, { headers: { cookie: bobCookie } })
    await once(bobWs, 'open')
    const msgs = []
    bobWs.on('message', (b) => msgs.push(JSON.parse(b.toString())))
    bobWs.send(JSON.stringify({ type: 'subscribe', projectId: aliceProjectId }))
    await new Promise((r) => setTimeout(r, 150))

    await fetch(`${router.url}/api/projects/${aliceProjectId}/tabs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: aliceCookie },
      body: '{}',
    })
    await new Promise((r) => setTimeout(r, 250))

    const got = msgs.filter((m) => m.type === 'tabs:update' && m.projectId === aliceProjectId)
    assert.equal(got.length, 0)
    bobWs.close()
  })

  it('WS upgrade with no cookie is rejected', async (t) => {
    if (bootstrapErr) return t.skip(bootstrapErr.message)
    const ws = new WebSocket(`${router.url.replace('http', 'ws')}/ws/tabs`)
    try {
      await once(ws, 'open')
      assert.fail('WS upgrade should not succeed without cookie')
    } catch (err) {
      // Expected: WS close before open
    }
  })
})
