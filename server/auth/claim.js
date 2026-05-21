/**
 * Single-use claim codes minted by the worker, consumed by the router's
 * /login endpoint. Each code is bound to {uid, username} and expires
 * after a short TTL (default 60s).
 *
 * Codes are 8 base32 characters formatted as XXXX-XXXX. Case is
 * normalized to upper on consume so users can retype in lowercase.
 */

import { randomBytes } from 'node:crypto'

const DEFAULT_TTL_MS = 60_000
const ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

/** Generate one XXXX-XXXX base32 code. */
function mintCode() {
  const buf = randomBytes(8)
  let out = ''
  for (let i = 0; i < 8; i++) {
    out += ALPHA[buf[i] % 32]
    if (i === 3) out += '-'
  }
  return out
}

/** Normalize user-typed code (uppercase, strip whitespace). */
function normalize(code) {
  if (typeof code !== 'string') return null
  const trimmed = code.trim().toUpperCase()
  if (!/^[A-Z2-7]{4}-[A-Z2-7]{4}$/.test(trimmed)) return null
  return trimmed
}

export class ClaimStore {
  constructor({ ttlMs = DEFAULT_TTL_MS } = {}) {
    this._ttlMs = ttlMs
    /** @type {Map<string, { uid, username, expiresAt }>} */
    this._claims = new Map()
  }

  /**
   * Mint a claim code bound to a uid.
   * Collision-handling: if a brand-new code happens to clash with an
   * outstanding one, retry. The 32^8 space is large enough that this
   * is a write-amplification non-issue.
   */
  mint({ uid, username }) {
    for (let attempt = 0; attempt < 10; attempt++) {
      const code = mintCode()
      if (this._claims.has(code)) continue
      const expiresAt = Date.now() + this._ttlMs
      this._claims.set(code, { uid, username, expiresAt })
      return { code, expiresAt }
    }
    throw new Error('claim store full / unlucky entropy')
  }

  /** Single-use consume. Returns the bound {uid, username} or null. */
  consume(code) {
    const norm = normalize(code)
    if (!norm) return null
    const entry = this._claims.get(norm)
    if (!entry) return null
    this._claims.delete(norm)
    if (entry.expiresAt <= Date.now()) return null
    return { uid: entry.uid, username: entry.username }
  }

  reapExpired() {
    const now = Date.now()
    let count = 0
    for (const [code, entry] of this._claims) {
      if (entry.expiresAt <= now) {
        this._claims.delete(code)
        count++
      }
    }
    return count
  }

  size() {
    return this._claims.size
  }
}
