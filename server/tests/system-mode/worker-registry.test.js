/**
 * Spec for the worker registry (server/auth/worker-registry.js).
 *
 * Public API expected:
 *   class WorkerRegistry {
 *     constructor({ idleEvictMs = 24*60*60*1000 })
 *     register({ uid, sock, peerCredUid }) → boolean
 *         // returns false if peerCredUid !== uid
 *     unregister(uid) → boolean
 *     get(uid) → { sock, lastSeen } | null
 *     touch(uid) → void                 // updates lastSeen
 *     reapIdle(now = Date.now()) → string[]   // returns uids reaped
 *     has(uid) → boolean
 *   }
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { tryImport, skip } from './fixtures/test-helpers.js'

const mod = await tryImport('../../auth/worker-registry.js')

describe('WorkerRegistry', () => {
  it('rejects registration when peerCredUid does not match claimed uid', (t) => {
    if (!mod) return skip(t, 'server/auth/worker-registry.js not implemented yet')
    const reg = new mod.WorkerRegistry()
    const ok = reg.register({ uid: 1001, sock: '/run/u-alice.sock', peerCredUid: 1002 })
    assert.equal(ok, false)
    assert.equal(reg.has(1001), false)
  })

  it('accepts registration when peerCredUid matches', (t) => {
    if (!mod) return skip(t, 'server/auth/worker-registry.js not implemented yet')
    const reg = new mod.WorkerRegistry()
    const ok = reg.register({ uid: 1001, sock: '/run/u-alice.sock', peerCredUid: 1001 })
    assert.equal(ok, true)
    assert.equal(reg.has(1001), true)
  })

  it('get() returns sock + lastSeen for a registered worker', (t) => {
    if (!mod) return skip(t, 'server/auth/worker-registry.js not implemented yet')
    const reg = new mod.WorkerRegistry()
    reg.register({ uid: 1001, sock: '/run/u-alice.sock', peerCredUid: 1001 })
    const got = reg.get(1001)
    assert.equal(got.sock, '/run/u-alice.sock')
    assert.ok(typeof got.lastSeen === 'number')
  })

  it('get() returns null for unknown uid', (t) => {
    if (!mod) return skip(t, 'server/auth/worker-registry.js not implemented yet')
    const reg = new mod.WorkerRegistry()
    assert.equal(reg.get(9999), null)
  })

  it('unregister() removes the entry and returns true; returns false on repeat', (t) => {
    if (!mod) return skip(t, 'server/auth/worker-registry.js not implemented yet')
    const reg = new mod.WorkerRegistry()
    reg.register({ uid: 1001, sock: '/run/u-alice.sock', peerCredUid: 1001 })
    assert.equal(reg.unregister(1001), true)
    assert.equal(reg.has(1001), false)
    assert.equal(reg.unregister(1001), false)
  })

  it('re-register replaces the existing entry (e.g. socket path changed)', (t) => {
    if (!mod) return skip(t, 'server/auth/worker-registry.js not implemented yet')
    const reg = new mod.WorkerRegistry()
    reg.register({ uid: 1001, sock: '/run/u-alice.sock', peerCredUid: 1001 })
    reg.register({ uid: 1001, sock: '/run/u-alice-v2.sock', peerCredUid: 1001 })
    assert.equal(reg.get(1001).sock, '/run/u-alice-v2.sock')
  })

  it('touch() advances lastSeen', async (t) => {
    if (!mod) return skip(t, 'server/auth/worker-registry.js not implemented yet')
    const reg = new mod.WorkerRegistry()
    reg.register({ uid: 1001, sock: '/run/u-alice.sock', peerCredUid: 1001 })
    const t0 = reg.get(1001).lastSeen
    await new Promise((r) => setTimeout(r, 5))
    reg.touch(1001)
    assert.ok(reg.get(1001).lastSeen > t0)
  })

  it('reapIdle() evicts workers older than idleEvictMs and returns their uids', (t) => {
    if (!mod) return skip(t, 'server/auth/worker-registry.js not implemented yet')
    const reg = new mod.WorkerRegistry({ idleEvictMs: 1000 })
    const now = Date.now()
    reg.register({ uid: 1001, sock: '/a', peerCredUid: 1001 })
    reg.register({ uid: 1002, sock: '/b', peerCredUid: 1002 })
    // Simulate 1001 idle 2s ago, 1002 fresh
    reg.get(1001).lastSeen = now - 2000
    reg.get(1002).lastSeen = now
    const reaped = reg.reapIdle(now)
    assert.deepEqual(reaped.sort(), [1001])
    assert.equal(reg.has(1001), false)
    assert.equal(reg.has(1002), true)
  })
})
