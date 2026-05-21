/**
 * Spawn a system-mode router for e2e tests.
 *
 * Usage:
 *   import { withRouter } from './fixtures/with-router.js'
 *   const { url, sessionTokenForUid, close } = await withRouter()
 *   try { ... } finally { await close() }
 *
 * Throws { code: 'NOT_IMPLEMENTED' } if router.js is absent so test files
 * can skip cleanly until P1–P5 land.
 *
 * The router must respect two test-only env vars (set ONLY when this
 * fixture is in use):
 *   NANOCODE_TEST_MODE=1                  enable test backdoors
 *   NANOCODE_TEST_SOCK_DIR=/tmp/...       socket dir override
 *
 * When NANOCODE_TEST_MODE=1, the router accepts a test-issuance endpoint
 *   POST /__test__/issue-session { uid, username, workerSock }
 * that returns a nano_sid cookie value. This bypasses claim codes for
 * automated testing. The endpoint MUST NOT respond when the env var
 * is unset — failing closed is part of the contract.
 */

import { existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { once } from 'node:events'

const ROUTER_PATH = resolve(import.meta.dirname, '../../../../router.js')

export async function withRouter() {
  if (!existsSync(ROUTER_PATH)) {
    const err = new Error('router.js missing — implement P1–P5 first')
    err.code = 'NOT_IMPLEMENTED'
    throw err
  }

  const port = 40700 + Math.floor(Math.random() * 200)
  const sockDir = mkdtempSync(join(tmpdir(), 'nano-system-test-'))
  const child = spawn('node', [ROUTER_PATH], {
    env: {
      ...process.env,
      NANOCODE_SYSTEM: '1',
      NANOCODE_TEST_MODE: '1',
      NANOCODE_TEST_SOCK_DIR: sockDir,
      HOST: '127.0.0.1',
      PORT: String(port),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  // Wait until router is ready
  let ready = false
  child.stdout.on('data', (b) => { if (b.toString().includes('Nanocode')) ready = true })
  for (let i = 0; i < 50 && !ready; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`)
      if (r.ok) { ready = true; break }
    } catch {}
    await new Promise((r) => setTimeout(r, 50))
  }
  if (!ready) {
    child.kill('SIGKILL')
    rmSync(sockDir, { recursive: true, force: true })
    throw new Error('router did not become ready')
  }

  const url = `http://127.0.0.1:${port}`

  /**
   * Test backdoor: mint a session for a fake uid without going through
   * the claim flow. Returns the nano_sid cookie value.
   */
  async function sessionTokenForUid({ uid, username, workerSock }) {
    const r = await fetch(`${url}/__test__/issue-session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uid, username, workerSock }),
    })
    if (!r.ok) throw new Error(`issue-session failed: ${r.status}`)
    const { sid } = await r.json()
    return sid
  }

  return {
    url,
    sockDir,
    sessionTokenForUid,
    async close() {
      child.kill('SIGTERM')
      try { await once(child, 'exit') } catch {}
      rmSync(sockDir, { recursive: true, force: true })
    },
  }
}
