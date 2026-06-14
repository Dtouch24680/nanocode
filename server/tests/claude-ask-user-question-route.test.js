import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createStore } from '../store.js'
import { createClaudeSessionController } from '../../terminal/claude-session-controller.js'

class MockWs extends EventEmitter {
  constructor() {
    super()
    this.readyState = 1
    this.sent = []
  }

  send(data) {
    this.sent.push(JSON.parse(data))
  }

  close() {
    this.readyState = 3
    this.emit('close')
  }
}

function emitJson(ws, payload) {
  ws.emit('message', JSON.stringify(payload))
}

describe('claude AskUserQuestion websocket response path', () => {
  it('resolves a pending dialog from claude-dialog-response and broadcasts the answered event', () => {
    const store = createStore(':memory:')
    const project = store.createProject('Ask User Question', process.cwd())
    const tab = store.createTab(project.id, { type: 'claude', label: 'claude ask' })
    const controller = createClaudeSessionController({ store, home: process.cwd(), recentAgents: { getRecentAgentsCached: () => [] } })

    const ws = new MockWs()
    controller.handleTerminalWs(ws)
    emitJson(ws, {
      type: 'attach',
      projectId: project.id,
      sessionType: 'bash',
      tabId: tab.id,
      cols: 120,
      rows: 40,
    })

    const sessionKey = `${project.id}:claude:${tab.id}`
    const cs = controller.claudeSessions.get(sessionKey)
    assert.ok(cs, 'expected Claude session to be created on attach')

    let resolved = null
    cs.pendingUserDialogs.set('dialog-1', {
      request: {
        dialogKind: 'ask_user_question',
        toolUseID: 'toolu_ask_1',
        payload: {
          questions: [
            {
              header: 'Flavor',
              question: 'Which option should we use?',
              multiSelect: false,
              options: [
                { label: 'Alpha', description: 'Use alpha' },
                { label: 'Beta', description: 'Use beta' },
              ],
            },
          ],
        },
      },
      finish(response) {
        resolved = response
        cs.pendingUserDialogs.delete('dialog-1')
        return true
      },
    })

    emitJson(ws, {
      type: 'claude-dialog-response',
      dialogId: 'dialog-1',
      behavior: 'completed',
      result: {
        questions: [
          {
            header: 'Flavor',
            question: 'Which option should we use?',
            multiSelect: false,
            options: [
              { label: 'Alpha', description: 'Use alpha' },
              { label: 'Beta', description: 'Use beta' },
            ],
          },
        ],
        answers: {
          'Which option should we use?': 'Beta',
        },
      },
    })

    assert.deepEqual(resolved, {
      behavior: 'completed',
      result: {
        questions: [
          {
            header: 'Flavor',
            question: 'Which option should we use?',
            multiSelect: false,
            options: [
              { label: 'Alpha', description: 'Use alpha' },
              { label: 'Beta', description: 'Use beta' },
            ],
          },
        ],
        answers: {
          'Which option should we use?': 'Beta',
        },
      },
    })
    assert.equal(cs.pendingUserDialogs.size, 0)

    const answeredEvent = ws.sent.find((msg) => (
      msg.type === 'claude-event' &&
      msg.event?.subtype === 'ask_user_question_answered'
    ))
    assert.ok(answeredEvent, 'expected ask_user_question_answered event to be broadcast')
    assert.equal(answeredEvent.event.dialog_id, 'dialog-1')
    assert.equal(answeredEvent.event.result.answers['Which option should we use?'], 'Beta')

    ws.close()
    store.close()
  })
})
