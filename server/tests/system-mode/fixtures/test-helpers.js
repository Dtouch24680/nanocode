/**
 * Shared test fixtures for system-mode tests.
 *
 * Each helper here is small + obvious so the tests stay readable.
 * Anything stateful (tmpdirs, sockets, child processes) returns a
 * cleanup function the test must call in an `after`/finally.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Try to import a module path. Returns the module or `null` if the file
 * doesn't exist yet (so suites can `t.skip()` cleanly until the
 * implementation lands).
 */
export async function tryImport(modulePath) {
  try {
    return await import(modulePath)
  } catch (err) {
    if (err.code === 'ERR_MODULE_NOT_FOUND' || err.code === 'MODULE_NOT_FOUND') return null
    throw err
  }
}

/** Make a fresh tmpdir. Returns { path, cleanup }. */
export function makeTmpDir(prefix = 'nanocode-test-') {
  const path = mkdtempSync(join(tmpdir(), prefix))
  return {
    path,
    cleanup() {
      try { rmSync(path, { recursive: true, force: true }) } catch {}
    },
  }
}

/** Synthetic passwd entries for test users. */
export const MOCK_USERS = {
  alice: { uid: 1001, gid: 1001, name: 'alice', home: '/tmp/test-home-alice', shell: '/bin/bash' },
  bob:   { uid: 1002, gid: 1002, name: 'bob',   home: '/tmp/test-home-bob',   shell: '/bin/bash' },
  daemon:{ uid: 1,    gid: 1,    name: 'daemon', home: '/usr/sbin',           shell: '/usr/sbin/nologin' },
}

/** Wait for a predicate to become true with a timeout. */
export async function waitFor(predicate, { timeoutMs = 2000, intervalMs = 20 } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`)
}

/**
 * Skip helper for node:test. Usage inside an `it`:
 *   if (!mod) return skip(t, 'auth/session.js not implemented yet')
 */
export function skip(t, reason) {
  return t.skip(reason)
}
