/**
 * Tests for the SQLite store (server/store.js).
 *
 * Each test gets a fresh in-memory database — no fixtures, no teardown.
 *
 * Architecture: server/docs/task-lifecycle.md#storage
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

  // --- Task CRUD ---

  it('createTask returns a task with correct fields', () => {
    const task = store.createTask({
      title: 'Test task',
      cwd: '/tmp',
    })
    assert.ok(task.id)
    assert.equal(task.title, 'Test task')
    assert.equal(task.type, 'task')
    assert.equal(task.status, 'pending')
    assert.equal(task.cwd, '/tmp')
    assert.equal(task.depends_on, null)
    assert.equal(task.turns, 0)
    assert.equal(task.cost_usd, 0)
    assert.ok(task.created_at > 0)
    assert.equal(task.started_at, null)
    assert.equal(task.ended_at, null)
  })

  it('createTask assigns incrementing seq numbers', () => {
    const t1 = store.createTask({ title: 'First', cwd: '/tmp' })
    const t2 = store.createTask({ title: 'Second', cwd: '/tmp' })
    const t3 = store.createTask({ title: 'Third', cwd: '/tmp' })
    assert.equal(t1.seq, 1)
    assert.equal(t2.seq, 2)
    assert.equal(t3.seq, 3)
  })

  it('createTask with type=plan', () => {
    const task = store.createTask({
      title: 'Plan something',
      type: 'plan',
      cwd: '/tmp',
    })
    assert.equal(task.type, 'plan')
  })

  it('getTask returns the task or undefined', () => {
    const created = store.createTask({ title: 'Find me', cwd: '/tmp' })
    const found = store.getTask(created.id)
    assert.deepEqual(found, created)

    const missing = store.getTask('nonexistent')
    assert.equal(missing, undefined)
  })

  it('listTasks returns all tasks ordered by seq', () => {
    store.createTask({ title: 'B', cwd: '/tmp' })
    store.createTask({ title: 'A', cwd: '/tmp' })
    store.createTask({ title: 'C', cwd: '/tmp' })

    const tasks = store.listTasks()
    assert.equal(tasks.length, 3)
    assert.equal(tasks[0].title, 'B')
    assert.equal(tasks[1].title, 'A')
    assert.equal(tasks[2].title, 'C')
  })

  it('updateTask updates allowed fields', () => {
    const task = store.createTask({ title: 'Update me', cwd: '/tmp' })

    const updated = store.updateTask(task.id, {
      status: 'running',
      started_at: Date.now(),
    })
    assert.equal(updated.status, 'running')
    assert.ok(updated.started_at > 0)
    assert.equal(updated.title, 'Update me')
  })

  it('updateTask rejects unknown fields', () => {
    const task = store.createTask({ title: 'Secure', cwd: '/tmp' })

    assert.throws(
      () => store.updateTask(task.id, { title: 'Hacked' }),
      /unknown field "title"/
    )
  })

  it('updateTask with empty fields returns task unchanged', () => {
    const task = store.createTask({ title: 'Unchanged', cwd: '/tmp' })
    const same = store.updateTask(task.id, {})
    assert.deepEqual(same, task)
  })

  // --- Dependencies ---

  it('createTask with depends_on references another task', () => {
    const dep = store.createTask({ title: 'Dependency', cwd: '/tmp' })
    const task = store.createTask({
      title: 'Dependent',
      cwd: '/tmp',
      dependsOn: dep.id,
    })
    assert.equal(task.depends_on, dep.id)
  })

  it('createTask with invalid depends_on throws foreign key error', () => {
    assert.throws(() =>
      store.createTask({
        title: 'Orphan',
        cwd: '/tmp',
        dependsOn: 'nonexistent',
      })
    )
  })

  // --- Events ---

  it('appendEvent stores and returns parsed event', () => {
    const task = store.createTask({ title: 'Events', cwd: '/tmp' })

    const event = store.appendEvent(task.id, 'text', { text: 'Hello' })
    assert.ok(event.id)
    assert.equal(event.task_id, task.id)
    assert.equal(event.kind, 'text')
    assert.deepEqual(event.data, { text: 'Hello' })
    assert.ok(event.created_at > 0)
  })

  it('getEvents returns events in order', () => {
    const task = store.createTask({ title: 'Stream', cwd: '/tmp' })

    store.appendEvent(task.id, 'text', { text: 'First' })
    store.appendEvent(task.id, 'tool_use', { name: 'Read', input: {} })
    store.appendEvent(task.id, 'text', { text: 'Second' })

    const events = store.getEvents(task.id)
    assert.equal(events.length, 3)
    assert.equal(events[0].kind, 'text')
    assert.deepEqual(events[0].data, { text: 'First' })
    assert.equal(events[1].kind, 'tool_use')
    assert.equal(events[2].kind, 'text')
    assert.deepEqual(events[2].data, { text: 'Second' })
  })

  it('getEvents with afterId returns only newer events', () => {
    const task = store.createTask({ title: 'Incremental', cwd: '/tmp' })

    const e1 = store.appendEvent(task.id, 'text', { text: 'Old' })
    const e2 = store.appendEvent(task.id, 'text', { text: 'New' })
    const e3 = store.appendEvent(task.id, 'text', { text: 'Newest' })

    const after = store.getEvents(task.id, e1.id)
    assert.equal(after.length, 2)
    assert.equal(after[0].id, e2.id)
    assert.equal(after[1].id, e3.id)
  })

  it('getEvents for task with no events returns empty array', () => {
    const task = store.createTask({ title: 'Empty', cwd: '/tmp' })
    const events = store.getEvents(task.id)
    assert.deepEqual(events, [])
  })
})
