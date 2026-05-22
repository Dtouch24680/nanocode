/**
 * Session store keyed by an opaque 32-byte (64 hex char) sid.
 *
 * Persisted to disk so router restarts don't log users out. The file
 * is owned root or `nanocode`, mode 0600. The contained tokens are
 * bearer credentials — anyone with read access can impersonate users.
 *
 * Persistence is opt-in via the `path` option. Without it the store
 * behaves as a pure in-memory map (used by tests and single-user mode).
 */

import { randomBytes } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  chmodSync,
} from 'node:fs'
import { dirname } from 'node:path'

const DEFAULT_TTL_MS = 3 * 24 * 60 * 60 * 1000 // 3 days

export class SessionStore {
  constructor({ ttlMs = DEFAULT_TTL_MS, path = null } = {}) {
    this._ttlMs = ttlMs
    this._path = path
    /** @type {Map<string, { uid, username, workerSock, expiresAt }>} */
    this._sessions = new Map()
    if (path) this._load()
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
    this._save()
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
      this._save()
      return false
    }
    s.expiresAt = Date.now() + this._ttlMs
    // Skip a save on every read-like touch; rely on the periodic reaper
    // to fold rolling-refresh values to disk. (Worst case: a router
    // restart resets a user's expiry to slightly earlier than expected.)
    this._dirty = true
    return true
  }

  revoke(sid) {
    const ok = this._sessions.delete(sid)
    if (ok) this._save()
    return ok
  }

  revokeAllForUid(uid) {
    let count = 0
    for (const [sid, s] of this._sessions) {
      if (s.uid === uid) {
        this._sessions.delete(sid)
        count++
      }
    }
    if (count) this._save()
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
    // Flush rolling-refresh updates accumulated since the last save.
    if (count || this._dirty) {
      this._dirty = false
      this._save()
    }
    return count
  }

  size() {
    return this._sessions.size
  }

  // --- Persistence ---

  _load() {
    if (!this._path || !existsSync(this._path)) return
    try {
      const data = JSON.parse(readFileSync(this._path, 'utf-8'))
      const now = Date.now()
      for (const entry of data) {
        if (!entry || !entry.sid || !entry.uid || !entry.expiresAt) continue
        if (entry.expiresAt <= now) continue
        this._sessions.set(entry.sid, {
          uid: entry.uid,
          username: entry.username,
          workerSock: entry.workerSock,
          expiresAt: entry.expiresAt,
        })
      }
    } catch {
      // Corrupt file — start fresh; next save overwrites.
    }
  }

  _save() {
    if (!this._path) return
    try {
      const dir = dirname(this._path)
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
      const data = []
      for (const [sid, s] of this._sessions) {
        data.push({ sid, ...s })
      }
      const tmp = this._path + '.tmp'
      writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 })
      try { chmodSync(tmp, 0o600) } catch {}
      renameSync(tmp, this._path)
      try { chmodSync(this._path, 0o600) } catch {}
    } catch {
      // Best-effort: a failed write doesn't disable the in-memory store.
    }
  }
}
