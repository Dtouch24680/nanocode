/**
 * In-memory registry of live per-user workers.
 *
 * Workers self-register over their Unix socket with a {uid, sock} pair.
 * The router validates that the kernel-attested peer UID matches the
 * claimed UID before accepting (defense against a compromised process
 * registering itself as a different user).
 *
 * Idle eviction tracks `lastSeen` (updated by router.touch on each
 * proxied request). A reaper runs periodically and unregisters workers
 * older than `idleEvictMs`.
 */

const DEFAULT_IDLE_EVICT_MS = 24 * 60 * 60 * 1000

export class WorkerRegistry {
  constructor({ idleEvictMs = DEFAULT_IDLE_EVICT_MS } = {}) {
    this._idleEvictMs = idleEvictMs
    /** @type {Map<number, { sock: string, lastSeen: number }>} */
    this._workers = new Map()
  }

  /**
   * Register a worker. Returns false if the kernel-attested peer UID
   * doesn't match the claimed UID — the caller must drop the
   * connection in that case.
   */
  register({ uid, sock, peerCredUid }) {
    if (peerCredUid !== uid) return false
    this._workers.set(uid, { sock, lastSeen: Date.now() })
    return true
  }

  unregister(uid) {
    return this._workers.delete(uid)
  }

  get(uid) {
    return this._workers.get(uid) || null
  }

  has(uid) {
    return this._workers.has(uid)
  }

  touch(uid) {
    const w = this._workers.get(uid)
    if (w) w.lastSeen = Date.now()
  }

  /**
   * Evict workers whose lastSeen is older than `idleEvictMs`.
   * Returns the list of evicted uids.
   */
  reapIdle(now = Date.now()) {
    const evicted = []
    for (const [uid, w] of this._workers) {
      if (now - w.lastSeen >= this._idleEvictMs) {
        this._workers.delete(uid)
        evicted.push(uid)
      }
    }
    return evicted
  }

  entries() {
    return [...this._workers.entries()].map(([uid, w]) => ({ uid, ...w }))
  }
}
