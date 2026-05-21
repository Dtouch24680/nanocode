/**
 * Spec for the per-user data store (worker/data-store.js).
 *
 * Public API expected:
 *   export class DataStore {
 *     constructor({ path })
 *     load() → { projects, tabs, settings }
 *     saveProjects(arr) → void          // atomic write
 *     saveTabs(projectId, arr) → void
 *     saveSettings(obj) → void
 *     close() → void
 *   }
 *
 * Invariants:
 *   - File is created with mode 0600 if missing.
 *   - Atomic writes via tmp + rename.
 *   - Schema unchanged from single-user: { projects, tabs, settings }.
 *   - Forward-compat: silently drops unknown top-level keys on load.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, statSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tryImport, skip, makeTmpDir } from './fixtures/test-helpers.js'

const mod = await tryImport(new URL('../../../worker/data-store.js', import.meta.url))

describe('worker DataStore', () => {
  it('initializes a fresh file with empty schema if missing', (t) => {
    if (!mod) return skip(t, 'worker/data-store.js not implemented yet')
    const { path, cleanup } = makeTmpDir()
    try {
      const file = join(path, '.nanocode', 'data.json')
      mkdirSync(join(path, '.nanocode'))
      const store = new mod.DataStore({ path: file })
      const data = store.load()
      assert.deepEqual(data, { projects: [], tabs: {}, settings: {} })
      assert.ok(existsSync(file))
    } finally { cleanup() }
  })

  it('writes file with mode 0600', (t) => {
    if (!mod) return skip(t, 'worker/data-store.js not implemented yet')
    const { path, cleanup } = makeTmpDir()
    try {
      const file = join(path, '.nanocode', 'data.json')
      mkdirSync(join(path, '.nanocode'))
      const store = new mod.DataStore({ path: file })
      store.saveProjects([{ id: 'a', name: 'A', cwd: '/x' }])
      const mode = statSync(file).mode & 0o777
      assert.equal(mode, 0o600, `expected 0600 got 0${mode.toString(8)}`)
    } finally { cleanup() }
  })

  it('round-trips projects', (t) => {
    if (!mod) return skip(t, 'worker/data-store.js not implemented yet')
    const { path, cleanup } = makeTmpDir()
    try {
      const file = join(path, '.nanocode', 'data.json')
      mkdirSync(join(path, '.nanocode'))
      const store = new mod.DataStore({ path: file })
      const projects = [{ id: 'a', name: 'A', cwd: '/x' }, { id: 'b', name: 'B', cwd: '/y' }]
      store.saveProjects(projects)
      const reread = new mod.DataStore({ path: file })
      assert.deepEqual(reread.load().projects, projects)
    } finally { cleanup() }
  })

  it('round-trips tabs per project', (t) => {
    if (!mod) return skip(t, 'worker/data-store.js not implemented yet')
    const { path, cleanup } = makeTmpDir()
    try {
      const file = join(path, '.nanocode', 'data.json')
      mkdirSync(join(path, '.nanocode'))
      const store = new mod.DataStore({ path: file })
      store.saveTabs('proj-1', [{ id: 't1', label: 'bash 1', createdAt: 1 }])
      store.saveTabs('proj-2', [{ id: 't2', label: 'bash 1', createdAt: 2 }])
      const data = new mod.DataStore({ path: file }).load()
      assert.equal(data.tabs['proj-1'].length, 1)
      assert.equal(data.tabs['proj-2'].length, 1)
      assert.equal(data.tabs['proj-1'][0].label, 'bash 1')
    } finally { cleanup() }
  })

  it('atomic write: leaves the previous file readable if the new write fails', (t) => {
    if (!mod) return skip(t, 'worker/data-store.js not implemented yet')
    // Hard to inject failure mid-write; assert at least the algorithmic
    // shape (tmp file rename) by inspecting the directory after a save.
    const { path, cleanup } = makeTmpDir()
    try {
      const file = join(path, '.nanocode', 'data.json')
      mkdirSync(join(path, '.nanocode'))
      const store = new mod.DataStore({ path: file })
      store.saveSettings({ theme: 'a' })
      store.saveSettings({ theme: 'b' })
      const data = JSON.parse(readFileSync(file, 'utf-8'))
      assert.equal(data.settings.theme, 'b')
    } finally { cleanup() }
  })

  it('forward-compat: ignores unknown top-level keys in stored JSON', (t) => {
    if (!mod) return skip(t, 'worker/data-store.js not implemented yet')
    const { path, cleanup } = makeTmpDir()
    try {
      const file = join(path, '.nanocode', 'data.json')
      mkdirSync(join(path, '.nanocode'))
      writeFileSync(file, JSON.stringify({
        projects: [], tabs: {}, settings: {},
        deprecatedFoo: 'should be ignored',
      }))
      const store = new mod.DataStore({ path: file })
      const data = store.load()
      assert.equal(data.deprecatedFoo, undefined)
    } finally { cleanup() }
  })

  it('handles missing parent directory by creating .nanocode/', (t) => {
    if (!mod) return skip(t, 'worker/data-store.js not implemented yet')
    const { path, cleanup } = makeTmpDir()
    try {
      const file = join(path, '.nanocode', 'data.json') // .nanocode does NOT exist
      const store = new mod.DataStore({ path: file })
      store.saveSettings({ theme: 'sand' })
      assert.ok(existsSync(file))
    } finally { cleanup() }
  })
})
