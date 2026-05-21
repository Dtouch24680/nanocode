/**
 * Spec for the claim-code store (server/auth/claim.js).
 *
 * Public API expected:
 *   class ClaimStore {
 *     constructor({ ttlMs = 60_000 })
 *     mint({ uid, username }) → { code, expiresAt }
 *     consume(code) → { uid, username } | null  // single-use; null on miss/expire/already-consumed
 *     reapExpired() → number
 *   }
 *
 * code is 8 base32 chars formatted as XXXX-XXXX (case-insensitive on consume).
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { tryImport, skip } from './fixtures/test-helpers.js'

const mod = await tryImport(new URL('../../auth/claim.js', import.meta.url))

describe('ClaimStore', () => {
  it('mints a XXXX-XXXX code from a base32 alphabet', (t) => {
    if (!mod) return skip(t, 'server/auth/claim.js not implemented yet')
    const store = new mod.ClaimStore()
    const { code } = store.mint({ uid: 1001, username: 'alice' })
    assert.match(code, /^[A-Z2-7]{4}-[A-Z2-7]{4}$/, 'XXXX-XXXX base32')
  })

  it('mints high-entropy codes', (t) => {
    if (!mod) return skip(t, 'server/auth/claim.js not implemented yet')
    const store = new mod.ClaimStore()
    const codes = new Set()
    for (let i = 0; i < 200; i++) {
      codes.add(store.mint({ uid: 1001, username: 'alice' }).code)
    }
    assert.equal(codes.size, 200, 'no collisions in 200 mints')
  })

  it('consume() returns the bound uid + username', (t) => {
    if (!mod) return skip(t, 'server/auth/claim.js not implemented yet')
    const store = new mod.ClaimStore()
    const { code } = store.mint({ uid: 1001, username: 'alice' })
    const got = store.consume(code)
    assert.deepEqual(got, { uid: 1001, username: 'alice' })
  })

  it('consume() is single-use', (t) => {
    if (!mod) return skip(t, 'server/auth/claim.js not implemented yet')
    const store = new mod.ClaimStore()
    const { code } = store.mint({ uid: 1001, username: 'alice' })
    assert.ok(store.consume(code))
    assert.equal(store.consume(code), null, 'second consume returns null')
  })

  it('consume() is case-insensitive', (t) => {
    if (!mod) return skip(t, 'server/auth/claim.js not implemented yet')
    const store = new mod.ClaimStore()
    const { code } = store.mint({ uid: 1001, username: 'alice' })
    const got = store.consume(code.toLowerCase())
    assert.ok(got, 'lowercase code accepted')
  })

  it('consume() returns null for unknown code', (t) => {
    if (!mod) return skip(t, 'server/auth/claim.js not implemented yet')
    const store = new mod.ClaimStore()
    assert.equal(store.consume('AAAA-BBBB'), null)
  })

  it('expires after ttlMs', async (t) => {
    if (!mod) return skip(t, 'server/auth/claim.js not implemented yet')
    const store = new mod.ClaimStore({ ttlMs: 30 })
    const { code } = store.mint({ uid: 1001, username: 'alice' })
    await new Promise((r) => setTimeout(r, 60))
    assert.equal(store.consume(code), null, 'expired code rejected')
  })

  it('reapExpired() returns the count of cleared codes', async (t) => {
    if (!mod) return skip(t, 'server/auth/claim.js not implemented yet')
    const store = new mod.ClaimStore({ ttlMs: 30 })
    store.mint({ uid: 1001, username: 'alice' })
    store.mint({ uid: 1002, username: 'bob' })
    await new Promise((r) => setTimeout(r, 60))
    assert.equal(store.reapExpired(), 2)
  })

  it('rejects malformed codes without storage side-effects', (t) => {
    if (!mod) return skip(t, 'server/auth/claim.js not implemented yet')
    const store = new mod.ClaimStore()
    assert.equal(store.consume('not-a-code'), null)
    assert.equal(store.consume(''), null)
    assert.equal(store.consume(null), null)
    assert.equal(store.consume('AAAA-BBBB-CCCC'), null)
  })
})
