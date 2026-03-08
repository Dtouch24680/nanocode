/**
 * Renders the live event stream for a running task.
 *
 * Appends events to the stream container as they arrive via WebSocket.
 * Replays stored events on view activation, then appends new ones live.
 *
 * Architecture: public/docs/event-rendering.md#task-detail
 */

import { el, md, formatCost, timeAgo } from './render.js'
import { state, selectTask } from './state.js'
import { updateTask, fetchEvents, continueTask } from './api.js'
import { send } from './ws.js'
import { switchTab } from './tab-bar.js'
import { openNewClaudeSession, isInitialized } from './terminal-view.js'

const panel = document.getElementById('detail-panel')
const titleEl = document.getElementById('detail-title')
const metaEl = document.getElementById('detail-meta')
const streamEl = document.getElementById('event-stream')
const actionsEl = document.getElementById('detail-actions')

// Close button
document.getElementById('detail-close').addEventListener('click', () => {
  selectTask(null)
})

/**
 * Render the full detail view for the selected task.
 *
 * Architecture: public/docs/event-rendering.md#task-detail
 */
export async function renderDetail() {
  const taskId = state.selectedTaskId
  if (!taskId) {
    panel.hidden = true
    return
  }

  const task = state.tasks.find((t) => t.id === taskId)
  if (!task) {
    panel.hidden = true
    return
  }

  // Hide plan panel, show detail panel
  document.getElementById('plan-review-panel').hidden = true
  panel.hidden = false

  titleEl.textContent = task.title

  // Meta row
  metaEl.innerHTML = ''
  const parts = [
    `Type: ${task.type}`,
    `Status: ${task.status}`,
    `Turns: ${task.turns}`,
    `Cost: ${formatCost(task.cost_usd)}`,
  ]
  if (task.created_at) parts.push(`Created: ${timeAgo(task.created_at)}`)
  if (task.started_at) parts.push(`Started: ${timeAgo(task.started_at)}`)
  if (task.ended_at) parts.push(`Ended: ${timeAgo(task.ended_at)}`)
  metaEl.textContent = parts.join(' · ')

  // Replay stored events
  streamEl.innerHTML = ''
  if (!state.events.has(taskId)) {
    // Fetch historical events
    try {
      const events = await fetchEvents(taskId)
      state.events.set(taskId, events)
    } catch {
      state.events.set(taskId, [])
    }
  }

  const events = state.events.get(taskId) || []
  for (const event of events) {
    streamEl.appendChild(renderEvent(event))
  }
  streamEl.scrollTop = streamEl.scrollHeight

  // Actions
  actionsEl.innerHTML = ''
  if (task.status === 'running') {
    const cancelBtn = el('button', {
      className: 'btn btn-danger',
      textContent: 'Cancel',
      onClick: async () => {
        try {
          await updateTask(task.id, { status: 'cancelled' })
        } catch (err) {
          console.error('Cancel failed:', err.message)
        }
      },
    })
    actionsEl.appendChild(cancelBtn)

    // Show "Resume in Terminal" for running tasks that have a session_id
    // (persisted as soon as the SDK provides it)
    if (task.session_id) {
      actionsEl.appendChild(
        el('button', {
          className: 'btn',
          textContent: 'Resume in Terminal',
          onClick: () => {
            selectTask(null)
            switchTab('terminal')
            if (isInitialized()) {
              openNewClaudeSession(task.session_id)
            }
          },
        })
      )
    }
  }

  if (task.status === 'failed') {
    actionsEl.appendChild(
      el('button', {
        className: 'btn btn-primary',
        textContent: 'Retry',
        onClick: async () => {
          try {
            await updateTask(task.id, { status: 'pending' })
          } catch (err) {
            console.error('Retry failed:', err.message)
          }
        },
      })
    )
  }

  if (task.status === 'done' || task.status === 'failed' || task.status === 'cancelled') {
    const hasSession = !!task.session_id
    actionsEl.appendChild(
      el('button', {
        className: 'btn',
        textContent: hasSession ? 'Resume in Terminal' : 'Open in Terminal',
        onClick: () => {
          selectTask(null)
          switchTab('terminal')
          if (isInitialized()) {
            openNewClaudeSession(hasSession ? task.session_id : undefined)
          }
        },
      })
    )

    // Continue input — only for tasks with a session to resume
    if (hasSession && (task.status === 'done' || task.status === 'failed')) {
      const continueRow = el('div', { className: 'continue-row' })
      const continueInput = el('input', {
        type: 'text',
        className: 'continue-input',
        placeholder: 'Follow-up prompt\u2026',
      })
      const continueBtn = el('button', {
        className: 'btn btn-primary',
        textContent: 'Continue',
        onClick: async () => {
          const title = continueInput.value.trim()
          if (!title) return
          try {
            continueBtn.disabled = true
            await continueTask(task.id, { title })
            continueInput.value = ''
          } catch (err) {
            console.error('Continue failed:', err.message)
          } finally {
            continueBtn.disabled = false
          }
        },
      })
      continueInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault()
          continueBtn.click()
        }
      })
      continueRow.appendChild(continueInput)
      continueRow.appendChild(continueBtn)
      actionsEl.appendChild(continueRow)
    }
  }
}

/**
 * Append a single event to the stream (O(1) for live events).
 *
 * @param {object} event
 */
export function appendEventToStream(event) {
  streamEl.appendChild(renderEvent(event))
  streamEl.scrollTop = streamEl.scrollHeight
}

/**
 * Render a single event to a DOM element.
 *
 * @param {object} event
 * @returns {HTMLElement}
 */
function renderEvent(event) {
  switch (event.kind) {
    case 'text':
      return el('div', { className: 'event-text', innerHTML: md(event.data.text) })

    case 'tool_use':
      return renderToolCall(event.data)

    case 'tool_result':
      return renderToolResult(event.data)

    case 'approval_req':
      return renderApprovalPrompt(event)

    case 'error':
      return el('div', {
        className: 'event-error',
        textContent: event.data.message,
      })

    default:
      return el('div', {
        className: 'event-text',
        textContent: `[${event.kind}]`,
      })
  }
}

/**
 * Render a tool call event.
 */
function renderToolCall(data) {
  const inputText =
    typeof data.input === 'string' ? data.input : JSON.stringify(data.input, null, 2)

  return el('div', { className: 'event-tool' }, [
    el('div', { className: 'event-tool-name', textContent: data.name }),
    el('pre', { className: 'event-tool-input', textContent: inputText }),
  ])
}

/**
 * Render a tool result event.
 */
function renderToolResult(data) {
  const content =
    typeof data.content === 'string'
      ? data.content
      : JSON.stringify(data.content, null, 2)

  return el('div', { className: 'event-tool' }, [
    el('div', {
      className: 'event-tool-name',
      textContent: 'Result',
    }),
    el('pre', { className: 'event-tool-input', textContent: content }),
  ])
}

/**
 * Render an approval request with Allow/Deny buttons.
 *
 * Architecture: server/docs/worker-streaming.md#approval-flow
 */
function renderApprovalPrompt(event) {
  const data = event.data
  const inputText =
    typeof data.input === 'string' ? data.input : JSON.stringify(data.input, null, 2)

  const container = el('div', { className: 'event-approval' }, [
    el('div', {
      className: 'event-tool-name',
      textContent: `${data.name} (approval required)`,
    }),
    el('pre', { className: 'event-tool-input', textContent: inputText }),
  ])

  const buttons = el('div', { className: 'approval-buttons' }, [
    el('button', {
      className: 'btn btn-primary',
      textContent: 'Allow',
      onClick: () => {
        send({
          type: 'approve',
          taskId: state.selectedTaskId,
          eventId: event.id,
          allow: true,
        })
        buttons.innerHTML = '<span>Allowed</span>'
      },
    }),
    el('button', {
      className: 'btn btn-danger',
      textContent: 'Deny',
      onClick: () => {
        send({
          type: 'approve',
          taskId: state.selectedTaskId,
          eventId: event.id,
          allow: false,
        })
        buttons.innerHTML = '<span>Denied</span>'
      },
    }),
  ])

  container.appendChild(buttons)
  return container
}
