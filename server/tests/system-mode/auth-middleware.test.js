/**
 * Spec for the auth middleware (server/middleware/auth.js).
 *
 * Public API expected:
 *   export function createAuthMiddleware({ sessionStore, loginPath = '/login' })
 *     → function (req, res, next)
 *
 *   export function authenticateWsUpgrade(req, sessionStore)
 *     → { uid, username, workerSock } | null
 *
 * The middleware:
 *   - Parses the nano_sid cookie from req.headers.cookie
 *   - Looks it up in the session store
 *   - On hit: sets req.user = { uid, username, workerSock }; touches the session; calls next()
 *   - On miss: for HTML requests (Accept: text/html) → 302 → loginPath
 *               for API requests (Accept: application/json or /api/* path) → 401 JSON
 *   - The /login page itself bypasses the middleware (caller's responsibility)
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { tryImport, skip } from './fixtures/test-helpers.js'

const mod = await tryImport(new URL('../../middleware/auth.js', import.meta.url))
const sessionMod = await tryImport(new URL('../../auth/session.js', import.meta.url))

function fakeReq(opts = {}) {
  return {
    method: opts.method || 'GET',
    url: opts.url || '/',
    headers: {
      ...(opts.cookie ? { cookie: opts.cookie } : {}),
      ...(opts.accept ? { accept: opts.accept } : {}),
      ...(opts.headers || {}),
    },
  }
}

function fakeRes() {
  const res = {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v },
    writeHead(code, headers) { this.statusCode = code; if (headers) Object.assign(this.headers, headers) },
    end(body) { this.body = body; this.ended = true },
    redirect(loc) { this.statusCode = 302; this.headers.location = loc; this.ended = true },
  }
  // express-style status/json shortcuts
  res.status = function (code) { this.statusCode = code; return this }
  res.json = function (obj) { this.headers['content-type'] = 'application/json'; this.body = JSON.stringify(obj); this.ended = true; return this }
  return res
}

describe('auth middleware (HTTP)', () => {
  it('passes through requests with a valid cookie and sets req.user', (t) => {
    if (!mod || !sessionMod) return skip(t, 'auth modules not implemented yet')
    const sessions = new sessionMod.SessionStore()
    const { sid } = sessions.create({ uid: 1001, username: 'alice', workerSock: '/x' })
    const mw = mod.createAuthMiddleware({ sessionStore: sessions })
    const req = fakeReq({ cookie: `nano_sid=${sid}` })
    const res = fakeRes()
    let nextCalled = false
    mw(req, res, () => { nextCalled = true })
    assert.equal(nextCalled, true)
    assert.equal(req.user.uid, 1001)
    assert.equal(req.user.username, 'alice')
    assert.equal(req.user.workerSock, '/x')
  })

  it('redirects HTML requests to /login when cookie is missing', (t) => {
    if (!mod || !sessionMod) return skip(t, 'auth modules not implemented yet')
    const sessions = new sessionMod.SessionStore()
    const mw = mod.createAuthMiddleware({ sessionStore: sessions })
    const req = fakeReq({ accept: 'text/html' })
    const res = fakeRes()
    mw(req, res, () => { throw new Error('next should not be called') })
    assert.equal(res.statusCode, 302)
    assert.equal(res.headers.location, '/login')
  })

  it('responds 401 JSON to /api/* requests with no cookie', (t) => {
    if (!mod || !sessionMod) return skip(t, 'auth modules not implemented yet')
    const sessions = new sessionMod.SessionStore()
    const mw = mod.createAuthMiddleware({ sessionStore: sessions })
    const req = fakeReq({ url: '/api/projects', accept: 'application/json' })
    const res = fakeRes()
    mw(req, res, () => { throw new Error('next should not be called') })
    assert.equal(res.statusCode, 401)
    assert.match(res.body, /unauthorized/i)
  })

  it('rejects an unknown/expired sid (401 or redirect)', (t) => {
    if (!mod || !sessionMod) return skip(t, 'auth modules not implemented yet')
    const sessions = new sessionMod.SessionStore()
    const mw = mod.createAuthMiddleware({ sessionStore: sessions })
    const req = fakeReq({ cookie: 'nano_sid=' + 'aa'.repeat(32) })
    const res = fakeRes()
    mw(req, res, () => { throw new Error('next should not be called') })
    assert.ok(res.statusCode === 401 || res.statusCode === 302)
  })

  it('parses cookie correctly when other cookies are present', (t) => {
    if (!mod || !sessionMod) return skip(t, 'auth modules not implemented yet')
    const sessions = new sessionMod.SessionStore()
    const { sid } = sessions.create({ uid: 1001, username: 'alice', workerSock: '/x' })
    const mw = mod.createAuthMiddleware({ sessionStore: sessions })
    const req = fakeReq({ cookie: `foo=bar; nano_sid=${sid}; theme=light` })
    const res = fakeRes()
    let nextCalled = false
    mw(req, res, () => { nextCalled = true })
    assert.equal(nextCalled, true)
    assert.equal(req.user.uid, 1001)
  })

  it('rolling refresh: touches the session on every authorized request', (t) => {
    if (!mod || !sessionMod) return skip(t, 'auth modules not implemented yet')
    const sessions = new sessionMod.SessionStore({ ttlMs: 1000 })
    const { sid, expiresAt: t0 } = sessions.create({ uid: 1001, username: 'alice', workerSock: '/x' })
    const mw = mod.createAuthMiddleware({ sessionStore: sessions })
    return new Promise((resolve) => {
      setTimeout(() => {
        mw(fakeReq({ cookie: `nano_sid=${sid}` }), fakeRes(), () => {})
        const t1 = sessions.get(sid).expiresAt
        assert.ok(t1 > t0, `expected refreshed expiry > original; ${t1} > ${t0}`)
        resolve()
      }, 30)
    })
  })
})

describe('auth middleware (WS upgrade)', () => {
  it('returns user info for a valid cookie', (t) => {
    if (!mod || !sessionMod) return skip(t, 'auth modules not implemented yet')
    const sessions = new sessionMod.SessionStore()
    const { sid } = sessions.create({ uid: 1001, username: 'alice', workerSock: '/x' })
    const req = fakeReq({ cookie: `nano_sid=${sid}` })
    const got = mod.authenticateWsUpgrade(req, sessions)
    assert.deepEqual(got, { uid: 1001, username: 'alice', workerSock: '/x' })
  })

  it('returns null for missing/invalid cookie', (t) => {
    if (!mod || !sessionMod) return skip(t, 'auth modules not implemented yet')
    const sessions = new sessionMod.SessionStore()
    assert.equal(mod.authenticateWsUpgrade(fakeReq({}), sessions), null)
    assert.equal(mod.authenticateWsUpgrade(fakeReq({ cookie: 'nano_sid=garbage' }), sessions), null)
  })
})
