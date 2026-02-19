/**
 * WebSocket connection for task events with auto-reconnect.
 *
 * Architecture: public/docs/state-management.md#websocket
 */

import { state, taskUpdated, eventReceived } from './state.js'
import { updateProviderLabels, switchProvider, isInitialized } from './terminal-view.js'

let ws = null
let reconnectTimer = null

/**
 * Connect to the codebuilder WebSocket server at /ws.
 */
export function connect() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }

  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
  ws = new WebSocket(`${protocol}//${location.host}/ws`)

  ws.addEventListener('open', () => {
    const el = document.getElementById('connection-status')
    el.textContent = 'Connected'
    el.classList.add('connected')
  })

  ws.addEventListener('message', (e) => {
    const msg = JSON.parse(e.data)
    switch (msg.type) {
      case 'task:updated':
        taskUpdated(msg.task)
        break
      case 'task:event':
        eventReceived(msg.taskId, msg.event)
        break
      case 'task:approval':
        eventReceived(msg.taskId, msg.event)
        break
      case 'settings:updated':
        if (msg.key === 'cli_provider') {
          state.cliProvider = msg.value || 'claude'
          if (isInitialized()) {
            updateProviderLabels()
            switchProvider()
          }
        }
        break
    }
  })

  ws.addEventListener('close', () => {
    const el = document.getElementById('connection-status')
    el.textContent = 'Disconnected'
    el.classList.remove('connected')
    reconnectTimer = setTimeout(() => connect(), 2000)
  })
}

/**
 * Send a JSON message over the WebSocket.
 *
 * @param {object} msg
 */
export function send(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg))
  }
}
