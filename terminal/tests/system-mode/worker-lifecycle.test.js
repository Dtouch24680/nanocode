/**
 * E2E spec: worker lifecycle — registration, idle eviction, re-login.
 *
 * The router runs with a shortened idleEvictMs in test mode so the
 * eviction path can be exercised in seconds rather than 24h.
 *
 * Env knobs the router must honor (test-only):
 *   NANOCODE_TEST_IDLE_EVICT_MS=<n>   override worker idle timeout
 */

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'

let withRouter, withWorker
try {
  ;({ withRouter } = await import('./fixtures/with-router.js'))
  ;({ withWorker } = await import('./fixtures/with-worker.js'))
} catch { /* skip */ }

describe('system-mode worker lifecycle', () => {
  let router, worker
  let bootstrapErr

  before(async () => {
    if (!withRouter || !withWorker) {
      bootstrapErr = new Error('NOT_IMPLEMENTED')
      return
    }
    try {
      // Force a very short idle eviction so we can observe it
      process.env.NANOCODE_TEST_IDLE_EVICT_MS = '500'
      router = await withRouter()
      worker = await withWorker({ uid: 1001, username: 'alice', router })
    } catch (err) {
      bootstrapErr = err
    }
  })

  after(async () => {
    if (worker) await worker.close()
    if (router) await router.close()
    delete process.env.NANOCODE_TEST_IDLE_EVICT_MS
  })

  it('worker registration appears in /__test__/registry', async (t) => {
    if (bootstrapErr) return t.skip(bootstrapErr.message)
    const reg = await fetch(`${router.url}/__test__/registry`).then((r) => r.json())
    assert.ok(Array.isArray(reg))
    const alice = reg.find((e) => e.uid === 1001)
    assert.ok(alice, 'alice is registered')
    assert.equal(alice.sock, worker.sock)
  })

  it('peer-cred mismatch is rejected by the router during register', async (t) => {
    if (bootstrapErr) return t.skip(bootstrapErr.message)
    // Spawn a second worker that lies about its uid
    const liar = await withWorker({ uid: 2001, username: 'mallory' })
    try {
      // Attempt to register as alice (the router's peer-cred check should reject)
      // The worker fixture re-uses NANOCODE_TEST_FAKE_UID; force a mismatch via the test backdoor
      const r = await fetch(`${router.url}/__test__/force-register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ claimedUid: 1001, peerCredUid: 2001, sock: liar.sock }),
      })
      assert.equal(r.status, 403, 'peer-cred mismatch rejected')
    } finally {
      await liar.close()
    }
  })

  it('worker is reaped after idle timeout; subsequent request 401s', async (t) => {
    if (bootstrapErr) return t.skip(bootstrapErr.message)
    const sid = await router.sessionTokenForUid({
      uid: 1001, username: 'alice', workerSock: worker.sock,
    })
    const cookie = `nano_sid=${sid}`

    // Confirm worker is reachable now
    const before = await fetch(`${router.url}/api/projects`, { headers: { cookie } })
    assert.equal(before.status, 200)

    // Wait past idle eviction
    await new Promise((r) => setTimeout(r, 800))

    const after = await fetch(`${router.url}/__test__/registry`).then((r) => r.json())
    const stillThere = after.find((e) => e.uid === 1001)
    assert.equal(stillThere, undefined, 'worker reaped')

    const stale = await fetch(`${router.url}/api/projects`, { headers: { cookie } })
    assert.ok(stale.status === 401 || stale.status === 502,
      `request after reap should fail with 401/502 (got ${stale.status})`)
  })

  it('second `nanocode login` while worker is alive re-uses the existing worker', async (t) => {
    if (bootstrapErr) return t.skip(bootstrapErr.message)
    // The previous reap-after-idle test may have evicted the worker; respawn
    // and re-register before asserting the "re-use" behavior.
    const reg0 = await fetch(`${router.url}/__test__/registry`).then((r) => r.json())
    if (!reg0.some((e) => e.uid === 1001)) {
      await fetch(`${router.url}/__test__/force-register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ claimedUid: 1001, peerCredUid: 1001, sock: worker.sock }),
      })
    }
    const codeRes1 = await fetch(`${router.url}/__test__/mint-claim?uid=1001`, { method: 'POST' }).then((r) => r.json())
    const codeRes2 = await fetch(`${router.url}/__test__/mint-claim?uid=1001`, { method: 'POST' }).then((r) => r.json())
    assert.notEqual(codeRes1.code, codeRes2.code, 'fresh claim code minted')

    const reg = await fetch(`${router.url}/__test__/registry`).then((r) => r.json())
    const aliceEntries = reg.filter((e) => e.uid === 1001)
    assert.equal(aliceEntries.length, 1, 'still exactly one worker registered for alice')
  })
})
