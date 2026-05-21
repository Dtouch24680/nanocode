/**
 * Spawn a worker process bound to a Unix socket, simulating a logged-in
 * user. The worker's data root is given as `home` — the worker writes
 * its data.json under home/.nanocode/.
 *
 * For test purposes the worker is launched WITHOUT going through the
 * setuid helper — it inherits the test runner's uid and pretends to be
 * the configured fake uid via the test-mode router backdoor.
 *
 * Throws { code: 'NOT_IMPLEMENTED' } if worker.js is absent.
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { once } from 'node:events'

const WORKER_PATH = resolve(import.meta.dirname, '../../../../worker/index.js')

export async function withWorker({ uid, username, router }) {
  if (!existsSync(WORKER_PATH)) {
    const err = new Error('worker.js missing — implement P1 first')
    err.code = 'NOT_IMPLEMENTED'
    throw err
  }

  const home = mkdtempSync(join(tmpdir(), `nano-home-${username}-`))
  // Workers create their socket in the router's sock dir so the router
  // can stat() it for ownership validation, and the worker's connection
  // back to the router happens over the router-controlled control sock.
  const sockDir = router ? router.sockDir : mkdtempSync(join(tmpdir(), `nano-worker-${username}-`))
  const sock = join(sockDir, `u-${username}.sock`)
  const routerSock = router ? join(router.sockDir, 'router.sock') : undefined

  const env = {
    ...process.env,
    HOME: home,
    USER: username,
    NANOCODE_TEST_MODE: '1',
    NANOCODE_TEST_FAKE_UID: String(uid),
    NANOCODE_TEST_FAKE_USERNAME: username,
    NANOCODE_WORKER_SOCK: sock,
  }
  if (routerSock) env.NANOCODE_ROUTER_SOCK = routerSock

  const child = spawn('node', [WORKER_PATH], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  // Capture worker output for debugging (failure cases append to err).
  const stderr = []
  child.stderr.on('data', (b) => stderr.push(b))
  child.stdout.on('data', (b) => stderr.push(b))
  child.on('exit', (code, signal) => {
    if (code !== 0 && code !== null) {
      stderr.push(Buffer.from(`\n[worker ${username} exited code=${code} signal=${signal}]\n`))
    }
  })

  // Wait for socket to appear
  for (let i = 0; i < 100; i++) {
    if (existsSync(sock)) break
    await new Promise((r) => setTimeout(r, 50))
  }
  if (!existsSync(sock)) {
    child.kill('SIGKILL')
    if (!router) rmSync(sockDir, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
    const log = Buffer.concat(stderr).toString('utf-8')
    throw new Error(`worker socket did not appear:\n${log}`)
  }

  return {
    sock,
    home,
    async close() {
      child.kill('SIGTERM')
      try { await once(child, 'exit') } catch {}
      rmSync(home, { recursive: true, force: true })
      if (!router) rmSync(sockDir, { recursive: true, force: true })
    },
  }
}
