/**
 * Spec for the session store (server/auth/session.js).
 *
 * Public API expected:
 *   class SessionStore {
 *     constructor({ ttlMs = 24*60*60*1000 })
 *     create({ uid, username, workerSock }) → { sid, expiresAt }
 *     get(sid) → { uid, username, workerSock, expiresAt } | null
 *     touch(sid) → boolean       // rolls expiry forward by ttlMs
 *     revoke(sid) → boolean
 *     revokeAllForUid(uid) → number
 *     reapExpired() → number
 *   }
 *
 * sid is a 32-byte cryptographically random hex string (64 chars).
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { tryImport, skip } from './fixtures/test-helpers.js'

const mod = await tryImport('../../auth/session.js')

describe('SessionStore', () => {
  it('mints a 64-char hex sid', (t) => {
    if (!mod) return skip(t, 'server/auth/session.js not implemented yet')
    const store = new mod.SessionStore()
    const { sid } = store.create({ uid: 1001, username: 'alice', workerSock: '/run/x.sock' })
    assert.match(sid, /^[0-9a-f]{64}$/)
  })

  it('mints unique sids on consecutive create() calls', (t) => {
    if (!mod) return skip(t, 'server/auth/session.js not implemented yet')
    const store = new mod.SessionStore()
    const sids = new Set()
    for (let i = 0; i < 100; i++) {
      sids.add(store.create({ uid: 1001, username: 'alice', workerSock: '/x' }).sid)
    }
    assert.equal(sids.size, 100)
  })

  it('round-trips uid + username + workerSock', (t) => {
    if (!mod) return skip(t, 'server/auth/session.js not implemented yet')
    const store = new mod.SessionStore()
    const { sid } = store.create({ uid: 1001, username: 'alice', workerSock: '/run/u-alice.sock' })
    const got = store.get(sid)
    assert.equal(got.uid, 1001)
    assert.equal(got.username, 'alice')
    assert.equal(got.workerSock, '/run/u-alice.sock')
    assert.ok(got.expiresAt > Date.now())
  })

  it('returns null for unknown sid', (t) => {
    if (!mod) return skip(t, 'server/auth/session.js not implemented yet')
    const store = new mod.SessionStore()
    assert.equal(store.get('deadbeef'.repeat(8)), null)
  })

  it('expires after ttlMs', (t) => {
    if (!mod) return skip(t, 'server/auth/session.js not implemented yet')
    const store = new mod.SessionStore({ ttlMs: 50 })
    const { sid } = store.create({ uid: 1001, username: 'alice', workerSock: '/x' })
    assert.ok(store.get(sid), 'fresh session readable')
    return new Promise((resolve) => {
      setTimeout(() => {
        assert.equal(store.get(sid), null, 'expired session returns null')
        resolve()
      }, 80)
    })
  })

  it('touch() rolls expiry forward', async (t) => {
    if (!mod) return skip(t, 'server/auth/session.js not implemented yet')
    const store = new mod.SessionStore({ ttlMs: 100 })
    const { sid, expiresAt } = store.create({ uid: 1001, username: 'alice', workerSock: '/x' })
    await new Promise((r) => setTimeout(r, 50))
    const ok = store.touch(sid)
    assert.equal(ok, true)
    const got = store.get(sid)
    assert.ok(got.expiresAt > expiresAt, 'expiry advances')
  })

  it('touch() returns false for unknown sid', (t) => {
    if (!mod) return skip(t, 'server/auth/session.js not implemented yet')
    const store = new mod.SessionStore()
    assert.equal(store.touch('zz'.repeat(32)), false)
  })

  it('revoke() removes a sid', (t) => {
    if (!mod) return skip(t, 'server/auth/session.js not implemented yet')
    const store = new mod.SessionStore()
    const { sid } = store.create({ uid: 1001, username: 'alice', workerSock: '/x' })
    assert.equal(store.revoke(sid), true)
    assert.equal(store.get(sid), null)
    assert.equal(store.revoke(sid), false, 'second revoke is a no-op')
  })

  it('revokeAllForUid() drops every session owned by a uid', (t) => {
    if (!mod) return skip(t, 'server/auth/session.js not implemented yet')
    const store = new mod.SessionStore()
    const a1 = store.create({ uid: 1001, username: 'alice', workerSock: '/x' }).sid
    const a2 = store.create({ uid: 1001, username: 'alice', workerSock: '/x' }).sid
    const b1 = store.create({ uid: 1002, username: 'bob',   workerSock: '/y' }).sid
    const count = store.revokeAllForUid(1001)
    assert.equal(count, 2)
    assert.equal(store.get(a1), null)
    assert.equal(store.get(a2), null)
    assert.ok(store.get(b1), "bob's session survives")
  })

  it('reapExpired() removes expired entries and returns the count', async (t) => {
    if (!mod) return skip(t, 'server/auth/session.js not implemented yet')
    const store = new mod.SessionStore({ ttlMs: 30 })
    store.create({ uid: 1001, username: 'alice', workerSock: '/x' })
    store.create({ uid: 1002, username: 'bob',   workerSock: '/y' })
    await new Promise((r) => setTimeout(r, 60))
    assert.equal(store.reapExpired(), 2)
  })
})
