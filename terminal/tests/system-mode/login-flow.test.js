/**
 * E2E spec: claim-from-terminal login.
 *
 * Covers the canonical flow:
 *   1. Worker boots → registers → mints claim code
 *   2. Browser POSTs claim code to /login → gets nano_sid cookie
 *   3. Subsequent requests carry the cookie → succeed
 *   4. Logout clears the session.
 *
 * Skips cleanly until P1–P5 land.
 */

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'

let withRouter, withWorker
try {
  ;({ withRouter } = await import('./fixtures/with-router.js'))
  ;({ withWorker } = await import('./fixtures/with-worker.js'))
} catch { /* leave undefined; tests will skip */ }

describe('system-mode login flow', () => {
  let router, worker
  let bootstrapErr

  before(async () => {
    if (!withRouter || !withWorker) {
      bootstrapErr = new Error('NOT_IMPLEMENTED')
      return
    }
    try {
      router = await withRouter()
      worker = await withWorker({ uid: 1001, username: 'alice', router })
    } catch (err) {
      bootstrapErr = err
    }
  })

  after(async () => {
    if (worker) await worker.close()
    if (router) await router.close()
  })

  it('happy path: claim code from worker → cookie → authorized request', async (t) => {
    if (bootstrapErr) return t.skip(bootstrapErr.message)

    // 1. Worker is registered with router and has a claim code in stdout.
    //    Test setup leaves the code retrievable via /__test__/last-claim?uid=
    const codeRes = await fetch(`${router.url}/__test__/last-claim?uid=1001`)
    const { code } = await codeRes.json()
    assert.match(code, /^[A-Z2-7]{4}-[A-Z2-7]{4}$/)

    // 2. POST /login with the code → gets a Set-Cookie nano_sid
    const loginRes = await fetch(`${router.url}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
      redirect: 'manual',
    })
    assert.equal(loginRes.status, 302)
    const setCookie = loginRes.headers.get('set-cookie') || ''
    const sidMatch = setCookie.match(/nano_sid=([^;]+)/)
    assert.ok(sidMatch, 'Set-Cookie nano_sid present')

    const cookie = `nano_sid=${sidMatch[1]}`

    // 3. Authorized request succeeds
    const projRes = await fetch(`${router.url}/api/projects`, {
      headers: { cookie },
    })
    assert.equal(projRes.status, 200)
    const projects = await projRes.json()
    assert.ok(Array.isArray(projects))

    // 4. whoami reports alice
    const me = await fetch(`${router.url}/api/auth/whoami`, { headers: { cookie } })
    const meBody = await me.json()
    assert.deepEqual(meBody, { uid: 1001, username: 'alice' })
  })

  it('rejects an expired claim code', async (t) => {
    if (bootstrapErr) return t.skip(bootstrapErr.message)

    const issued = await fetch(`${router.url}/__test__/issue-expired-claim?uid=1001`).then((r) => r.json())
    const res = await fetch(`${router.url}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: issued.code }),
      redirect: 'manual',
    })
    assert.equal(res.status, 401)
  })

  it('rejects an unknown / malformed claim code', async (t) => {
    if (bootstrapErr) return t.skip(bootstrapErr.message)

    for (const code of ['', 'XXXX', 'NOPE-NOPE', null]) {
      const res = await fetch(`${router.url}/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
        redirect: 'manual',
      })
      assert.equal(res.status, 401, `code=${JSON.stringify(code)} should be 401`)
    }
  })

  it('claim code is single-use: second consume returns 401', async (t) => {
    if (bootstrapErr) return t.skip(bootstrapErr.message)

    // Mint a fresh code so earlier tests' consumption doesn't interfere.
    const { code } = await fetch(`${router.url}/__test__/mint-claim?uid=1001`, { method: 'POST' }).then((r) => r.json())
    const first = await fetch(`${router.url}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
      redirect: 'manual',
    })
    assert.equal(first.status, 302)
    const second = await fetch(`${router.url}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
      redirect: 'manual',
    })
    assert.equal(second.status, 401)
  })

  it('logout clears the session', async (t) => {
    if (bootstrapErr) return t.skip(bootstrapErr.message)

    const sid = await router.sessionTokenForUid({
      uid: 1001, username: 'alice', workerSock: worker.sock,
    })
    const cookie = `nano_sid=${sid}`
    const before = await fetch(`${router.url}/api/auth/whoami`, { headers: { cookie } })
    assert.equal(before.status, 200)

    await fetch(`${router.url}/logout`, { method: 'POST', headers: { cookie } })

    const after = await fetch(`${router.url}/api/auth/whoami`, { headers: { cookie } })
    assert.equal(after.status, 401)
  })

  it('redirects unauthenticated HTML requests to /login', async (t) => {
    if (bootstrapErr) return t.skip(bootstrapErr.message)
    const r = await fetch(`${router.url}/`, {
      headers: { accept: 'text/html' },
      redirect: 'manual',
    })
    assert.equal(r.status, 302)
    assert.equal(r.headers.get('location'), '/login')
  })

  it('responds 401 to unauthenticated /api/* with JSON accept', async (t) => {
    if (bootstrapErr) return t.skip(bootstrapErr.message)
    const r = await fetch(`${router.url}/api/projects`, {
      headers: { accept: 'application/json' },
    })
    assert.equal(r.status, 401)
  })
})
