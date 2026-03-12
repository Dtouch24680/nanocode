/**
 * Tests for the SQLite store.
 *
 * Architecture: docs/architecture.md#data-model
 */

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '../store.js'

describe('store', () => {
  let store

  beforeEach(() => {
    store = createStore(':memory:')
  })

  afterEach(() => {
    store.close()
  })

  it('creates and fetches projects', () => {
    const project = store.createProject('Alpha', '/tmp/alpha')
    assert.ok(project.id)
    assert.equal(project.name, 'Alpha')
    assert.equal(project.cwd, '/tmp/alpha')
    assert.deepEqual(store.getProject(project.id), project)
  })

  it('lists projects in creation order', () => {
    store.createProject('One', '/tmp/one')
    store.createProject('Two', '/tmp/two')
    store.createProject('Three', '/tmp/three')

    const projects = store.listProjects()
    assert.equal(projects.length, 3)
    assert.equal(projects[0].name, 'One')
    assert.equal(projects[1].name, 'Two')
    assert.equal(projects[2].name, 'Three')
  })

  it('upserts settings and returns the full settings map', () => {
    assert.equal(store.getSetting('cli_provider'), null)

    store.setSetting('cli_provider', 'claude')
    store.setSetting('theme', 'glass')
    store.setSetting('cli_provider', 'opencode')

    assert.equal(store.getSetting('cli_provider'), 'opencode')
    assert.deepEqual(store.getAllSettings(), {
      cli_provider: 'opencode',
      theme: 'glass',
    })
  })

  it('archives and unarchives sessions per project', () => {
    const project = store.createProject('Alpha', '/tmp/alpha')

    store.archiveSession(project.id, 'session-a')
    store.archiveSession(project.id, 'session-b')
    assert.deepEqual(store.listArchivedSessions(project.id), ['session-a', 'session-b'])

    store.unarchiveSession(project.id, 'session-a')
    assert.deepEqual(store.listArchivedSessions(project.id), ['session-b'])
  })

  it('tracks managed sessions without duplicates', () => {
    const project = store.createProject('Alpha', '/tmp/alpha')

    store.markSessionManaged(project.id, 'session-a')
    store.markSessionManaged(project.id, 'session-a')
    store.markSessionManaged(project.id, 'session-b')

    assert.deepEqual(store.listManagedSessions(project.id), ['session-a', 'session-b'])
  })

  it('removes related session metadata when a project is deleted', () => {
    const project = store.createProject('Alpha', '/tmp/alpha')
    store.archiveSession(project.id, 'session-a')
    store.markSessionManaged(project.id, 'session-b')

    store.removeProject(project.id)

    assert.equal(store.getProject(project.id), undefined)
    assert.deepEqual(store.listArchivedSessions(project.id), [])
    assert.deepEqual(store.listManagedSessions(project.id), [])
  })

  it('creates a remote project with SSH fields', () => {
    const project = store.createProject('Remote', '/home/ubuntu/proj', null, {
      host: '10.0.1.5',
      user: 'ubuntu',
      port: 2222,
      key: '~/.ssh/id_ed25519',
    })
    assert.equal(project.ssh_host, '10.0.1.5')
    assert.equal(project.ssh_user, 'ubuntu')
    assert.equal(project.ssh_port, 2222)
    assert.equal(project.ssh_key, '~/.ssh/id_ed25519')
  })

  it('creates a local project with null SSH fields', () => {
    const project = store.createProject('Local', '/tmp/local')
    assert.equal(project.ssh_host, null)
    assert.equal(project.ssh_user, null)
    assert.equal(project.ssh_port, null)
    assert.equal(project.ssh_key, null)
  })
})
