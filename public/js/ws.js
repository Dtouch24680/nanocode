/**
 * WebSocket connection with auto-reconnect.
 *
 * Architecture: public/docs/state-management.md#websocket
 */

import { taskUpdated, eventReceived } from './state.js'

let ws = null
let reconnectTimer = null

/**
 * Connect to the WebSocket server.
 *
 * @param {string} url — ws:// or wss:// URL
 */
export function connect(url) {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }

  ws = new WebSocket(url)

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
    }
  })

  ws.addEventListener('close', () => {
    const el = document.getElementById('connection-status')
    el.textContent = 'Disconnected'
    el.classList.remove('connected')
    reconnectTimer = setTimeout(() => connect(url), 2000)
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
