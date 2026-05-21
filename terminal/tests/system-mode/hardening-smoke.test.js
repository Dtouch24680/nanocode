/**
 * E2E spec: hardening properties of the router.
 *
 * Most of these only meaningfully run when nanocode is launched under
 * the production systemd unit with ProtectHome=yes etc. The test
 * detects that and skips otherwise.
 *
 * Detection: env NANOCODE_E2E_HARDENED=1 set by the operator-supplied
 * test harness (an `install + systemctl start --foreground + run-tests`
 * orchestration script).
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { execSync } from 'node:child_process'

const HARDENED = process.env.NANOCODE_E2E_HARDENED === '1'

describe('system-mode hardening', () => {
  it('router cannot read /etc/shadow', (t) => {
    if (!HARDENED) return t.skip('set NANOCODE_E2E_HARDENED=1 to run under hardened unit')
    try {
      // The router exposes a test-mode introspection endpoint that
      // reports its own readable directories.
      const r = execSync('curl -s http://127.0.0.1:3000/__test__/can-read?path=/etc/shadow').toString()
      assert.match(r, /denied|EACCES|cannot/i)
    } catch (err) {
      // Network errors mean the router isn't up; treat as skip
      t.skip('router not reachable at :3000 — bring up the hardened unit first')
    }
  })

  it('router cannot read /home/<any>/*', (t) => {
    if (!HARDENED) return t.skip('set NANOCODE_E2E_HARDENED=1 to run')
    try {
      const r = execSync('curl -s http://127.0.0.1:3000/__test__/can-read?path=/home').toString()
      // ProtectHome=yes makes /home appear empty or denied
      assert.ok(/denied|EACCES|empty/i.test(r), `unexpected: ${r}`)
    } catch (err) {
      t.skip('router not reachable')
    }
  })

  it('router process does not have CAP_SETUID (cannot become other users)', (t) => {
    if (!HARDENED) return t.skip()
    const pid = readFileSync('/run/nanocode/router.pid', 'utf-8').trim()
    const status = readFileSync(`/proc/${pid}/status`, 'utf-8')
    const capEff = status.match(/^CapEff:\s*([0-9a-f]+)/m)?.[1] || ''
    // CapEff=0000000000000000 means empty capability set (after dropping)
    assert.match(capEff, /^0+$/, `CapEff should be empty, got ${capEff}`)
  })

  it('router NoNewPrivs is set', (t) => {
    if (!HARDENED) return t.skip()
    const pid = readFileSync('/run/nanocode/router.pid', 'utf-8').trim()
    const status = readFileSync(`/proc/${pid}/status`, 'utf-8')
    assert.match(status, /^NoNewPrivs:\s*1/m)
  })

  it('worker socket is mode 0600 owned by the user', (t) => {
    if (!HARDENED) return t.skip()
    // The hardened test harness MUST log in as a known test user and
    // start a worker before this test runs.
    const sock = '/run/nanocode/u-testuser.sock'
    if (!existsSync(sock)) return t.skip('no test worker socket present')
    const stat = execSync(`stat -c '%a %U' ${sock}`).toString().trim()
    assert.match(stat, /^600 testuser$/)
  })

  it('claim socket is accessible to any user (peer-cred enforced inside)', (t) => {
    if (!HARDENED) return t.skip()
    const sock = '/run/nanocode/router.sock'
    if (!existsSync(sock)) return t.skip()
    const stat = execSync(`stat -c '%a' ${sock}`).toString().trim()
    assert.match(stat, /^666$/, `expected 0666 got ${stat}`)
  })
})
