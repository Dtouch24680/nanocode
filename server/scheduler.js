/**
 * Task scheduling loop.
 *
 * Picks pending tasks, checks dependency resolution, starts workers
 * up to MAX_CONCURRENCY.
 *
 * Architecture: server/docs/task-lifecycle.md#scheduling
 */

import { Worker } from './worker.js'

const MAX_CONCURRENCY = parseInt(process.env.MAX_CONCURRENCY, 10) || 2
const TICK_INTERVAL_MS = 2000

/**
 * Create a scheduler that manages the task→worker lifecycle.
 *
 * @param {object} store — store API
 * @param {Map<string, Worker>} workers — shared worker pool (taskId → Worker)
 * @param {function} broadcast — fn(msg) to push to all WS clients
 * @returns {{ tick: function, start: function, stop: function }}
 *
 * Architecture: server/docs/task-lifecycle.md#scheduling
 */
export function createScheduler(store, workers, broadcast) {
  let intervalId = null

  /**
   * Single scheduling pass.
   *
   * Filters pending tasks, checks dependency resolution, respects
   * MAX_CONCURRENCY, and starts workers for eligible tasks.
   */
  function tick() {
    const tasks = store.listTasks()
    const pending = tasks.filter((t) => t.status === 'pending')

    for (const task of pending) {
      if (workers.size >= MAX_CONCURRENCY) break

      // Skip if dependency hasn't completed
      if (task.depends_on) {
        const dep = store.getTask(task.depends_on)
        if (!dep || dep.status !== 'done') continue
      }

      // Start worker
      const worker = new Worker(task, store, broadcast)
      workers.set(task.id, worker)

      // Run asynchronously, clean up when done
      worker
        .run()
        .catch((err) => {
          console.error(`Worker ${task.id} crashed:`, err.message)
        })
        .finally(() => {
          workers.delete(task.id)
          // Re-tick after completion to pick up newly unblocked tasks
          tick()
        })
    }
  }

  /**
   * Start the scheduling loop.
   */
  function start() {
    tick()
    intervalId = setInterval(tick, TICK_INTERVAL_MS)
  }

  /**
   * Stop the scheduling loop.
   */
  function stop() {
    if (intervalId) {
      clearInterval(intervalId)
      intervalId = null
    }
  }

  return { tick, start, stop }
}
