import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ReplayCache } from '../../public/js/claude-block-renderer/replay-cache.js'
import { pairToolResult, stampToolUseIdentity } from '../../public/js/claude-block-renderer/tool-result-pair.js'

describe('ReplayCache', () => {
  it('tracks fetched replay keys and subagent uuids', () => {
    const cache = new ReplayCache()
    cache.rememberFetchedEvents([
      { type: 'user', replay_id: 'user:1' },
      { type: 'assistant', uuid: 'assistant-1' },
    ])

    assert.equal(cache.hasTransportReplay({ replay_id: 'user:1' }), true)
    assert.equal(cache.hasTransportReplay({ uuid: 'assistant-1' }), true)
    assert.equal(cache.hasTransportReplay({ replay_id: 'user:2' }), false)

    assert.equal(cache.markSubagentSeen('sub-1'), false)
    assert.equal(cache.markSubagentSeen('sub-1'), true)
  })
})

describe('tool result pairing helpers', () => {
  it('stamps tool identity and injects result HTML into a paired tool block', () => {
    let copied = false
    const runningBadge = { removeCalled: false, remove() { this.removeCalled = true } }
    const outputDiv = { innerHTML: '' }
    const toolBlock = {
      _toolId: null,
      setAttribute(name, value) {
        if (name === 'data-tool-id') this._toolId = value
      },
      classList: {
        removed: [],
        added: [],
        remove(name) { this.removed.push(name) },
        add(name) { this.added.push(name) },
      },
      querySelector(selector) {
        if (selector === '.cbr-tool-running-badge') return runningBadge
        if (selector === '.cbr-tool-output') return outputDiv
        return null
      },
    }
    const scrollRoot = {
      querySelector(selector) {
        return selector === '[data-tool-id="tool-1"]' ? toolBlock : null
      },
    }

    stampToolUseIdentity(toolBlock, 'tool-1')

    const paired = pairToolResult({
      scrollRoot,
      toolUseId: 'tool-1',
      resultHtml: '<div>done</div>',
      isError: true,
      attachCopyHandlers: () => { copied = true },
    })

    assert.equal(toolBlock._toolId, 'tool-1')
    assert.equal(paired, true)
    assert.equal(outputDiv.innerHTML, '<div>done</div>')
    assert.deepEqual(toolBlock.classList.removed, ['cbr-tool-loading-state'])
    assert.deepEqual(toolBlock.classList.added, ['cbr-tool-block--error'])
    assert.equal(runningBadge.removeCalled, true)
    assert.equal(copied, true)
  })
})
