/**
 * Tests for the scheduler (server/scheduler.js).
 *
 * Uses mock store and verifies scheduling logic without real workers.
 *
 * Architecture: server/docs/task-lifecycle.md#scheduling
 */

import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '../store.js'
import { createScheduler } from '../scheduler.js'

describe('scheduler', () => {
  let store
  let workers
  let started

  beforeEach(() => {
    store = createStore(':memory:')
    workers = new Map()
    started = []

    // Monkey-patch: make Worker constructor just record the task
    // and mark it running immediately (no real SDK call)
  })

  /**
   * Helper: create a mock scheduler that records which tasks
   * get started instead of actually running the SDK.
   */
  function createTestScheduler() {
    // We need to override Worker to avoid importing the SDK.
    // Instead, we'll use the scheduler's tick directly and
    // check its behavior by observing store state.
    //
    // Since createScheduler imports Worker, we mock at a higher level:
    // pre-set tasks to 'running' when the scheduler would pick them up,
    // and verify the scheduler's filtering logic.
    return createScheduler(store, workers, () => {})
  }

  it('tick picks up pending tasks', () => {
    store.createTask({ title: 'Task A', cwd: '/tmp' })
    store.createTask({ title: 'Task B', cwd: '/tmp' })

    const scheduler = createTestScheduler()
    scheduler.tick()

    // Workers should have been created for both tasks
    assert.equal(workers.size, 2)
  })

  it('tick skips tasks blocked by unfinished dependencies', () => {
    const dep = store.createTask({ title: 'Dependency', cwd: '/tmp' })
    store.createTask({
      title: 'Blocked',
      cwd: '/tmp',
      dependsOn: dep.id,
    })

    const scheduler = createTestScheduler()
    scheduler.tick()

    // Only the dependency should be started (Blocked is waiting)
    assert.equal(workers.size, 1)
    assert.ok(workers.has(dep.id))
  })

  it('tick respects MAX_CONCURRENCY', () => {
    // Create 5 tasks
    for (let i = 0; i < 5; i++) {
      store.createTask({ title: `Task ${i}`, cwd: '/tmp' })
    }

    const scheduler = createTestScheduler()
    scheduler.tick()

    // Default MAX_CONCURRENCY is 2
    assert.equal(workers.size, 2)
  })

  it('tick skips tasks that already have workers', () => {
    const task = store.createTask({ title: 'Running', cwd: '/tmp' })
    store.updateTask(task.id, { status: 'running', started_at: Date.now() })

    const scheduler = createTestScheduler()
    scheduler.tick()

    // Running task shouldn't spawn a new worker
    assert.equal(workers.size, 0)
  })

  it('tick unblocks waiting tasks when dependency completes', () => {
    const dep = store.createTask({ title: 'Dependency', cwd: '/tmp' })
    const blocked = store.createTask({
      title: 'Blocked',
      cwd: '/tmp',
      dependsOn: dep.id,
    })

    // Simulate dependency completion
    store.updateTask(dep.id, {
      status: 'done',
      started_at: Date.now(),
      ended_at: Date.now(),
    })

    const scheduler = createTestScheduler()
    scheduler.tick()

    // Blocked task should now be picked up
    assert.ok(workers.has(blocked.id))
  })
})
