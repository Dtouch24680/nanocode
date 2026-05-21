/**
 * In-memory session store keyed by an opaque 32-byte (64 hex char) sid.
 *
 * No persistence: a router restart logs everyone out. The cost is small
 * (the user re-runs `nanocode login`) and the security upside is real
 * (no on-disk session table to leak).
 */

import { randomBytes } from 'node:crypto'

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000

export class SessionStore {
  constructor({ ttlMs = DEFAULT_TTL_MS } = {}) {
    this._ttlMs = ttlMs
    /** @type {Map<string, { uid, username, workerSock, expiresAt }>} */
    this._sessions = new Map()
  }

  /**
   * Mint a fresh session.
   * @param {{ uid: number, username: string, workerSock: string }} info
   * @returns {{ sid: string, expiresAt: number }}
   */
  create({ uid, username, workerSock }) {
    const sid = randomBytes(32).toString('hex')
    const expiresAt = Date.now() + this._ttlMs
    this._sessions.set(sid, { uid, username, workerSock, expiresAt })
    return { sid, expiresAt }
  }

  get(sid) {
    const s = this._sessions.get(sid)
    if (!s) return null
    if (s.expiresAt <= Date.now()) {
      this._sessions.delete(sid)
      return null
    }
    return { ...s }
  }

  touch(sid) {
    const s = this._sessions.get(sid)
    if (!s) return false
    if (s.expiresAt <= Date.now()) {
      this._sessions.delete(sid)
      return false
    }
    s.expiresAt = Date.now() + this._ttlMs
    return true
  }

  revoke(sid) {
    return this._sessions.delete(sid)
  }

  revokeAllForUid(uid) {
    let count = 0
    for (const [sid, s] of this._sessions) {
      if (s.uid === uid) {
        this._sessions.delete(sid)
        count++
      }
    }
    return count
  }

  reapExpired() {
    const now = Date.now()
    let count = 0
    for (const [sid, s] of this._sessions) {
      if (s.expiresAt <= now) {
        this._sessions.delete(sid)
        count++
      }
    }
    return count
  }

  size() {
    return this._sessions.size
  }
}
