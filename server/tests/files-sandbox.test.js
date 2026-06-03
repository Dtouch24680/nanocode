/**
 * Tests for the cross-project / home-root sandbox logic in terminal/files.js.
 *
 * These tests exercise resolveWithFallback() directly (exported as _resolveWithFallback)
 * to verify sandbox enforcement without needing a running HTTP server.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { _resolveWithFallback } from '../../terminal/files.js'

const HOME_ROOT = '/storage/home/zhiningjiao'

// Minimal mock store
function makeStore(projects = []) {
  return {
    listProjects: () => projects,
  }
}

// Minimal mock project
function makeProject({ cwd, ssh_host = null } = {}) {
  return { id: 'proj-1', cwd, ssh_host }
}

describe('resolveWithFallback — sandbox rules', () => {
  // ── Relative paths: standard project sandbox ──────────────────────────────

  it('relative path within project cwd is allowed', () => {
    const project = makeProject({ cwd: `${HOME_ROOT}/code/nanocode` })
    const result = _resolveWithFallback(project, makeStore(), 'server/index.js')
    assert.equal(result.crossProject, false)
    assert.ok(result.target.startsWith(`${HOME_ROOT}/code/nanocode`))
    assert.equal(result.rel, 'server/index.js')
  })

  it('relative path traversal outside project cwd is rejected', () => {
    const project = makeProject({ cwd: `${HOME_ROOT}/code/nanocode` })
    assert.throws(
      () => _resolveWithFallback(project, makeStore(), '../../etc/passwd'),
      (err) => err.status === 403
    )
  })

  // ── Absolute paths: current project ──────────────────────────────────────

  it('absolute path inside current project cwd is allowed (crossProject=false)', () => {
    const project = makeProject({ cwd: `${HOME_ROOT}/code/nanocode` })
    const abs = `${HOME_ROOT}/code/nanocode/server/index.js`
    const result = _resolveWithFallback(project, makeStore(), abs)
    assert.equal(result.crossProject, false)
    assert.equal(result.target, abs)
  })

  // ── Absolute paths: matched other project ────────────────────────────────

  it('absolute path inside another project cwd is allowed (crossProject=true)', () => {
    const project = makeProject({ cwd: `${HOME_ROOT}/code/nanocode` })
    const otherProject = { id: 'proj-2', cwd: `${HOME_ROOT}/code/4path`, ssh_host: null }
    const store = makeStore([project, otherProject])
    const abs = `${HOME_ROOT}/code/4path/README.md`
    const result = _resolveWithFallback(project, store, abs)
    assert.equal(result.crossProject, true)
    assert.equal(result.target, abs)
    assert.equal(result.root, `${HOME_ROOT}/code/4path`)
  })

  // ── Absolute paths: home-root fallback ───────────────────────────────────

  it('absolute path under HOME_ROOT (no project match) falls back to home-root sandbox', () => {
    const project = makeProject({ cwd: `${HOME_ROOT}/code/nanocode` })
    const abs = `${HOME_ROOT}/codex_work/sandbox_test.md`
    const result = _resolveWithFallback(project, makeStore(), abs)
    assert.equal(result.crossProject, true)
    assert.equal(result.target, abs)
    assert.equal(result.root, HOME_ROOT)
    assert.equal(result.rel, 'codex_work/sandbox_test.md')
  })

  // ── Absolute paths: outside home root — MUST be rejected ─────────────────

  it('absolute path outside HOME_ROOT (/etc) is rejected', () => {
    const project = makeProject({ cwd: `${HOME_ROOT}/code/nanocode` })
    assert.throws(
      () => _resolveWithFallback(project, makeStore(), '/etc/hostname'),
      (err) => err.status === 403
    )
  })

  it('absolute path in another user home is rejected', () => {
    const project = makeProject({ cwd: `${HOME_ROOT}/code/nanocode` })
    assert.throws(
      () => _resolveWithFallback(project, makeStore(), '/storage/home/otheruser/secret'),
      (err) => err.status === 403
    )
  })

  it('absolute path at root / is rejected', () => {
    const project = makeProject({ cwd: `${HOME_ROOT}/code/nanocode` })
    assert.throws(
      () => _resolveWithFallback(project, makeStore(), '/'),
      (err) => err.status === 403
    )
  })

  // ── Remote projects — always rejected ────────────────────────────────────

  it('remote project throws REMOTE error', () => {
    const project = makeProject({ cwd: `${HOME_ROOT}/code/nanocode`, ssh_host: '10.0.0.1' })
    assert.throws(
      () => _resolveWithFallback(project, makeStore(), 'server/index.js'),
      (err) => err.code === 'REMOTE' && err.status === 400
    )
  })

  // ── SSH projects in the store are skipped ─────────────────────────────────

  it('remote project in store list is skipped for cross-project match', () => {
    const project = makeProject({ cwd: `${HOME_ROOT}/code/nanocode` })
    const remoteProj = { id: 'proj-ssh', cwd: `${HOME_ROOT}/code/4path`, ssh_host: '10.0.0.1' }
    const store = makeStore([project, remoteProj])
    // Even though path looks like it matches remoteProj, it's SSH → skip → home-root fallback
    const abs = `${HOME_ROOT}/code/4path/README.md`
    const result = _resolveWithFallback(project, store, abs)
    // Falls to home-root since SSH project is skipped
    assert.equal(result.root, HOME_ROOT)
    assert.equal(result.crossProject, true)
  })
})
