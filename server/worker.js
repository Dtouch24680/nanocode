/**
 * Claude SDK wrapper — one Worker instance per running task.
 *
 * Iterates the async generator from `query()`, maps SDK messages to
 * store events, and broadcasts them over WebSocket.
 *
 * Architecture: server/docs/worker-streaming.md
 */

import { query } from '@anthropic-ai/claude-agent-sdk'

/** Tools that are safe to auto-approve (read-only). */
const READ_ONLY_TOOLS = new Set([
  'Read',
  'Glob',
  'Grep',
  'WebSearch',
  'WebFetch',
  'TodoRead',
  'Task',
])

/** Tools that plan tasks must never use (write operations). */
const PLAN_DENY_TOOLS = new Set([
  'Write',
  'Edit',
  'Bash',
  'NotebookEdit',
])

/** Default timeout for waiting on UI approval (under SDK's 60s limit). */
const APPROVAL_TIMEOUT_MS = 55_000

export class Worker {
  /**
   * @param {object} task — task row from the store
   * @param {object} store — store API
   * @param {function} broadcast — fn(msg) to push to all WS clients
   *
   * Architecture: server/docs/worker-streaming.md#worker-startup
   */
  constructor(task, store, broadcast) {
    this.task = task
    this.store = store
    this.broadcast = broadcast
    this.queryInstance = null
    this.sessionId = null
    this.turns = 0
    this.costUsd = 0
    this.textChunks = []
    this._approvalResolvers = new Map()
    this._aborted = false
  }

  /**
   * Run the task through the Claude SDK.
   *
   * Architecture: server/docs/worker-streaming.md#run-loop
   */
  async run() {
    // Mark running
    this.store.updateTask(this.task.id, {
      status: 'running',
      started_at: Date.now(),
    })
    this.broadcast({
      type: 'task:updated',
      task: this.store.getTask(this.task.id),
    })

    try {
      const prompt = this._buildPrompt()
      const options = this._buildOptions()

      this.queryInstance = query({ prompt, options })

      for await (const message of this.queryInstance) {
        if (this._aborted) break
        this._processMessage(message)
      }

      if (!this._aborted) {
        this._complete()
      }
    } catch (err) {
      this._fail(err)
    }
  }

  /**
   * Build the prompt, incorporating plan context and feedback.
   */
  _buildPrompt() {
    const parts = []

    if (this.task.type === 'plan') {
      parts.push(
        'Create a detailed implementation plan. Do NOT write any code or make any file changes.',
        'Only use read-only tools (Read, Glob, Grep) to understand the codebase.',
        'Output your plan as structured markdown.',
        '',
      )
    }

    // If this task has feedback (from plan confirmation or revision), include it
    if (this.task.feedback) {
      if (this.task.type === 'plan') {
        parts.push(
          '## Previous feedback to incorporate:',
          this.task.feedback,
          '',
        )
      } else {
        parts.push(
          '## Implementation plan to follow:',
          this.task.feedback,
          '',
        )
      }
    }

    parts.push(this.task.title)
    return parts.join('\n')
  }

  /**
   * Build SDK options for the query.
   */
  _buildOptions() {
    const isPlan = this.task.type === 'plan'
    return {
      cwd: this.task.cwd,
      model: process.env.CLAUDE_MODEL || 'sonnet',
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      settingSources: ['project', 'user', 'local'],
      permissionMode: isPlan ? 'plan' : 'default',
      allowedTools: isPlan
        ? ['Read', 'Glob', 'Grep', 'Task', 'WebSearch', 'WebFetch', 'TodoRead', 'TodoWrite']
        : [],
      canUseTool: (toolName, input, context) =>
        this._handleToolApproval(toolName, input, context),
    }
  }

  /**
   * Process a single SDK message.
   *
   * Architecture: server/docs/worker-streaming.md#message-types
   */
  _processMessage(message) {
    switch (message.type) {
      case 'system':
        if (message.session_id) {
          this.sessionId = message.session_id
        }
        break

      case 'assistant': {
        this.turns++
        if (!message.message?.content) break
        for (const block of message.message.content) {
          if (block.type === 'text') {
            this.textChunks.push(block.text)
            const event = this.store.appendEvent(
              this.task.id,
              'text',
              { text: block.text }
            )
            this.broadcast({
              type: 'task:event',
              taskId: this.task.id,
              event,
            })
          } else if (block.type === 'tool_use') {
            const event = this.store.appendEvent(
              this.task.id,
              'tool_use',
              { name: block.name, input: block.input }
            )
            this.broadcast({
              type: 'task:event',
              taskId: this.task.id,
              event,
            })
          } else if (block.type === 'tool_result') {
            const event = this.store.appendEvent(
              this.task.id,
              'tool_result',
              { tool_use_id: block.tool_use_id, content: block.content }
            )
            this.broadcast({
              type: 'task:event',
              taskId: this.task.id,
              event,
            })
          }
        }
        break
      }

      case 'result': {
        // Extract cost from model usage
        if (message.modelUsage) {
          const modelKey = Object.keys(message.modelUsage)[0]
          const usage = message.modelUsage[modelKey]
          if (usage) {
            // Rough cost estimate based on token counts
            const inputTokens =
              (usage.cumulativeInputTokens || usage.inputTokens || 0) +
              (usage.cumulativeCacheReadInputTokens || usage.cacheReadInputTokens || 0)
            const outputTokens =
              usage.cumulativeOutputTokens || usage.outputTokens || 0
            // Approximate: $3/M input, $15/M output (Sonnet)
            this.costUsd =
              (inputTokens / 1_000_000) * 3 +
              (outputTokens / 1_000_000) * 15
          }
        }
        break
      }
    }
  }

  /**
   * Handle tool approval requests.
   *
   * Auto-approves read-only tools. For plan tasks, denies write tools.
   * For regular tasks, prompts the user via WebSocket.
   *
   * Architecture: server/docs/worker-streaming.md#approval-flow
   */
  async _handleToolApproval(toolName, input, context) {
    // Auto-approve read-only tools
    if (READ_ONLY_TOOLS.has(toolName)) {
      return { behavior: 'allow', updatedInput: input }
    }

    // Plan tasks: deny write operations
    if (this.task.type === 'plan' && PLAN_DENY_TOOLS.has(toolName)) {
      return {
        behavior: 'deny',
        message: 'Plan tasks cannot use write tools',
      }
    }

    // Store approval request event and ask user
    const event = this.store.appendEvent(
      this.task.id,
      'approval_req',
      { name: toolName, input }
    )
    this.broadcast({
      type: 'task:approval',
      taskId: this.task.id,
      event,
    })

    // Wait for user decision
    return new Promise((resolve) => {
      let settled = false
      const signal = context?.signal

      const finalize = (decision) => {
        if (settled) return
        settled = true
        this._approvalResolvers.delete(event.id)
        clearTimeout(timeout)
        if (signal) signal.removeEventListener('abort', onAbort)
        resolve(decision)
      }

      const timeout = setTimeout(() => {
        finalize({ behavior: 'deny', message: 'Approval timed out' })
      }, APPROVAL_TIMEOUT_MS)

      const onAbort = () => {
        finalize({ behavior: 'deny', message: 'Request cancelled' })
      }

      if (signal) {
        if (signal.aborted) {
          finalize({ behavior: 'deny', message: 'Request cancelled' })
          return
        }
        signal.addEventListener('abort', onAbort, { once: true })
      }

      this._approvalResolvers.set(event.id, finalize)
    })
  }

  /**
   * Resolve a pending approval from the UI.
   *
   * @param {number} eventId
   * @param {boolean} allow
   */
  handleApproval(eventId, allow) {
    const resolver = this._approvalResolvers.get(eventId)
    if (resolver) {
      resolver(
        allow
          ? { behavior: 'allow' }
          : { behavior: 'deny', message: 'User denied' }
      )
    }
  }

  /**
   * Mark task as completed. For plans, concatenate text into plan_result.
   *
   * Architecture: server/docs/task-lifecycle.md#completion
   */
  _complete() {
    const isPlan = this.task.type === 'plan'
    const status = isPlan ? 'review' : 'done'
    const updates = {
      status,
      turns: this.turns,
      cost_usd: this.costUsd,
      ended_at: Date.now(),
    }

    if (isPlan) {
      updates.plan_result = this.textChunks.join('\n')
    }

    this.store.updateTask(this.task.id, updates)
    this.broadcast({
      type: 'task:updated',
      task: this.store.getTask(this.task.id),
    })
  }

  /**
   * Mark task as failed with an error event.
   *
   * Architecture: server/docs/task-lifecycle.md#failure
   */
  _fail(err) {
    const event = this.store.appendEvent(this.task.id, 'error', {
      message: err.message,
    })
    this.broadcast({
      type: 'task:event',
      taskId: this.task.id,
      event,
    })

    this.store.updateTask(this.task.id, {
      status: 'failed',
      turns: this.turns,
      cost_usd: this.costUsd,
      ended_at: Date.now(),
    })
    this.broadcast({
      type: 'task:updated',
      task: this.store.getTask(this.task.id),
    })
  }

  /**
   * Abort the running SDK session.
   *
   * Architecture: server/docs/task-lifecycle.md#cancellation
   */
  async abort() {
    this._aborted = true
    if (this.queryInstance) {
      try {
        await this.queryInstance.interrupt()
      } catch {
        // Ignore interrupt errors
      }
    }
  }
}
