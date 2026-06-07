// Regression test for the desktop "busy 时发消息不入队、直接滚走" bug.
//
// Root cause: ClaudeBlockRenderer set thinking=true ONLY in sendInputWithEcho()
// (local echo). Any turn this client did not locally start — page reload /
// reconnect mid-turn, a fast turn whose result raced ahead, a turn started from
// another client — left isClaudeThinking=false, so the desktop composer took the
// "send immediately" branch instead of queueing into the tray (mobile/CLI queue).
//
// Fix: derive thinking from the live server event stream — any live (non-replay)
// turn-progress event marks thinking=true; 'result' ends it. jsonl replay
// (fromReplay) must NOT mark busy so restoring a completed session stays idle.
//
// Also covers: subagent event isolation (parent_tool_use_id guard).
// Subagent events (assistant/stream_event/result with parent_tool_use_id set)
// must NOT affect main-turn thinking state. Subagent result must NOT dispatch
// nanocode:turn-complete or call _setThinking(false) for the main turn.
//
// This test drives the REAL ClaudeBlockRenderer through its REAL _handleEvent
// entry point with the actual event shapes the SDK emits (captured live via a
// WS probe against the SDK driver). No internal helpers are bypassed.

import { before, describe, it } from 'node:test'
import assert from 'node:assert/strict'

function makeElement(tag) {
  const children = []
  const listeners = {}
  return {
    tagName: tag.toUpperCase(),
    className: '', innerHTML: '', hidden: false, title: '', style: {}, dataset: {},
    children,
    get scrollHeight() { return 0 },
    get scrollTop() { return 0 },
    set scrollTop(_v) {},
    get clientHeight() { return 0 },
    classList: {
      _set: new Set(),
      add(c) { this._set.add(c) }, remove(c) { this._set.delete(c) },
      contains(c) { return this._set.has(c) },
      toggle(c, force) {
        if (force === true) this._set.add(c)
        else if (force === false) this._set.delete(c)
        else if (this._set.has(c)) this._set.delete(c)
        else this._set.add(c)
      },
    },
    setAttribute() {}, getAttribute() { return null },
    appendChild(child) { children.push(child); return child },
    insertBefore(node, ref) {
      const idx = children.indexOf(ref)
      if (idx === -1) children.push(node); else children.splice(idx, 0, node)
      return node
    },
    removeChild(child) { const i = children.indexOf(child); if (i !== -1) children.splice(i, 1) },
    querySelector(sel) {
      const cls = sel.startsWith('.') ? sel.slice(1) : null
      if (!cls) return null
      for (const c of children) if (typeof c.className === 'string' && c.className.split(' ').includes(cls)) return c
      return null
    },
    querySelectorAll(sel) {
      const cls = sel.startsWith('.') ? sel.slice(1) : null
      if (!cls) return []
      return children.filter((c) => typeof c.className === 'string' && c.className.split(' ').includes(cls))
    },
    addEventListener(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn) },
    dispatchEvent(ev) { for (const fn of listeners[ev.type] || []) fn(ev) },
    scrollTo() {},
  }
}

// Capture dispatched document-level CustomEvents so we can assert the
// nanocode:claude-thinking signal that terminal-view.js listens on.
const dispatched = []
global.document = {
  createElement: (tag) => makeElement(tag),
  createDocumentFragment: () => makeElement('fragment'),
  createTextNode: (text) => ({ nodeValue: text, parentElement: null }),
  createTreeWalker: () => ({ nextNode: () => null }),
  addEventListener: () => {},
  dispatchEvent: (ev) => { dispatched.push(ev); return true },
  querySelectorAll: () => [],
}
global.CustomEvent = class { constructor(type, init) { this.type = type; this.detail = init?.detail } }
global.NodeFilter = { SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2 }
global.requestAnimationFrame = (fn) => { fn(); return 0 }
global.location = { protocol: 'http:', host: 'localhost:3001' }
global.WebSocket = class { constructor() {} set onopen(_v) {} set onmessage(_v) {} set onerror(_v) {} set onclose(_v) {} close() {} }
global.fetch = async () => ({ ok: true, json: async () => ({}) })
// localStorage stub: getItem returns null (→ default behaviour: subagent activity visible)
global.localStorage = { _store: {}, getItem(k) { return this._store[k] ?? null }, setItem(k, v) { this._store[k] = v }, removeItem(k) { delete this._store[k] } }

let ClaudeBlockRenderer
before(async () => {
  const mod = await import('../../public/js/claude-block-renderer.js')
  ClaudeBlockRenderer = mod.ClaudeBlockRenderer
})

function makeRenderer() {
  dispatched.length = 0
  const container = makeElement('div')
  const r = new ClaudeBlockRenderer(container, {})
  r.tabId = 'tab-1'
  return r
}

function thinkingEvents() {
  return dispatched.filter((e) => e.type === 'nanocode:claude-thinking')
}

describe('ClaudeBlockRenderer server-driven busy detection', () => {
  it('marks thinking=true on a live SDK assistant event (turn not locally started)', () => {
    const r = makeRenderer()
    assert.equal(r.isThinking(), false)
    // Live assistant event arriving without any prior local echo (e.g. reload mid-turn)
    r._handleEvent({ type: 'assistant', message: { role: 'assistant', id: 'm1', content: [{ type: 'text', text: 'hi' }] } })
    assert.equal(r.isThinking(), true, 'assistant event should put renderer into thinking state')
    const evs = thinkingEvents()
    assert.ok(evs.some((e) => e.detail.thinking === true && e.detail.tabId === 'tab-1'),
      'should dispatch nanocode:claude-thinking{thinking:true} so the composer queues follow-ups')
  })

  it('marks thinking=true on a live SDK stream_event (the type SDK actually emits)', () => {
    const r = makeRenderer()
    r._handleEvent({ type: 'stream_event', event: { type: 'content_block_delta' } })
    assert.equal(r.isThinking(), true)
  })

  it('marks thinking=true on system/init and system/status (SDK turn-start signals)', () => {
    const r1 = makeRenderer()
    r1._handleEvent({ type: 'system', subtype: 'init', session_id: 's1', tools: [] })
    assert.equal(r1.isThinking(), true, 'system/init starts the turn')

    const r2 = makeRenderer()
    r2._handleEvent({ type: 'system', subtype: 'status' })
    assert.equal(r2.isThinking(), true, 'system/status indicates an active turn')
  })

  it('clears thinking on the terminal result event', () => {
    const r = makeRenderer()
    r._handleEvent({ type: 'assistant', message: { role: 'assistant', id: 'm1', content: [{ type: 'text', text: 'hi' }] } })
    assert.equal(r.isThinking(), true)
    r._handleEvent({ type: 'result', subtype: 'success', usage: {} })
    assert.equal(r.isThinking(), false, 'result must end thinking so the queue can flush')
    const evs = thinkingEvents()
    assert.equal(evs[evs.length - 1].detail.thinking, false)
  })

  it('does NOT mark thinking on a completed-session jsonl replay (fromReplay)', () => {
    const r = makeRenderer()
    // Restoring history of a finished session must not falsely show busy.
    r._handleEvent({ type: 'assistant', message: { role: 'assistant', id: 'm1', content: [{ type: 'text', text: 'old' }] } }, { fromReplay: true })
    r._handleEvent({ type: 'result', subtype: 'success', usage: {} }, { fromReplay: true })
    assert.equal(r.isThinking(), false, 'replayed completed turn should leave renderer idle')
    assert.equal(thinkingEvents().length, 0, 'no thinking event should fire during replay')
  })

  it('non-turn system subtypes (queued/info) do NOT mark thinking', () => {
    const r = makeRenderer()
    r._handleEvent({ type: 'system', subtype: 'queued', text: 'Message queued (position 1).' })
    r._handleEvent({ type: 'system', subtype: 'info', text: 'something' })
    assert.equal(r.isThinking(), false, 'queued/info are not turn-progress signals')
  })

  it('is idempotent — repeated live events do not spam thinking events', () => {
    const r = makeRenderer()
    r._handleEvent({ type: 'system', subtype: 'init', session_id: 's1', tools: [] })
    r._handleEvent({ type: 'stream_event', event: {} })
    r._handleEvent({ type: 'assistant', message: { role: 'assistant', id: 'm1', content: [{ type: 'text', text: 'x' }] } })
    // _setThinking no-ops when unchanged → only ONE thinking=true dispatch
    const trueEvents = thinkingEvents().filter((e) => e.detail.thinking === true)
    assert.equal(trueEvents.length, 1, 'thinking=true should dispatch exactly once for one turn')
  })
})

// ── Subagent event isolation ──────────────────────────────────────────────────
// Regression guard for: subagent events (parent_tool_use_id set) must NOT
// affect main-turn thinking state. The main turn dispatched a Task tool and is
// waiting — thinking should stay stable (true) while the subagent runs, and
// subagent result must NOT trigger turn-complete or _setThinking(false).

describe('ClaudeBlockRenderer subagent event isolation (parent_tool_use_id guard)', () => {
  it('subagent assistant event does NOT trigger _setThinking(true) when main turn is idle', () => {
    const r = makeRenderer()
    assert.equal(r.isThinking(), false)
    // A subagent assistant event arrives (parent_tool_use_id set) — must not change thinking
    r._handleEvent({
      type: 'assistant',
      parent_tool_use_id: 'toolu_sa1',
      message: { role: 'assistant', id: 'msg_sa1', content: [{ type: 'text', text: 'subagent says hi' }] },
    })
    assert.equal(r.isThinking(), false,
      'subagent assistant event must NOT set thinking=true on idle main turn')
    const evs = thinkingEvents()
    assert.equal(evs.length, 0, 'no nanocode:claude-thinking event should fire for subagent assistant')
  })

  it('subagent stream_event does NOT trigger _setThinking(true)', () => {
    const r = makeRenderer()
    r._handleEvent({
      type: 'stream_event',
      parent_tool_use_id: 'toolu_sa1',
      event: { type: 'content_block_delta' },
    })
    assert.equal(r.isThinking(), false,
      'subagent stream_event must NOT mark main turn as thinking')
  })

  it('subagent events do NOT cause thinking to flicker when main turn is thinking', () => {
    const r = makeRenderer()
    // Main turn starts
    r._handleEvent({ type: 'system', subtype: 'init', session_id: 's1', tools: [] })
    assert.equal(r.isThinking(), true, 'main turn should be thinking after init')

    // Track thinking events from here on
    const baseLen = thinkingEvents().length

    // Subagent streams several events
    r._handleEvent({
      type: 'assistant',
      parent_tool_use_id: 'toolu_sa1',
      message: { role: 'assistant', id: 'msg_sa1', content: [{ type: 'text', text: 'sub output' }] },
    })
    r._handleEvent({
      type: 'stream_event',
      parent_tool_use_id: 'toolu_sa1',
      event: { type: 'content_block_delta' },
    })

    // thinking must remain true, no extra thinking events dispatched
    assert.equal(r.isThinking(), true, 'thinking must stay true while subagent runs')
    const newEvs = thinkingEvents().slice(baseLen)
    assert.equal(newEvs.length, 0, 'subagent events must NOT dispatch any nanocode:claude-thinking events')
  })

  it('subagent result does NOT trigger turn-complete or _setThinking(false) on main turn', () => {
    const r = makeRenderer()
    // Main turn starts
    r._handleEvent({ type: 'system', subtype: 'init', session_id: 's1', tools: [] })
    assert.equal(r.isThinking(), true)

    // Subagent finishes — sends result with parent_tool_use_id
    r._handleEvent({
      type: 'result',
      parent_tool_use_id: 'toolu_sa1',
      subtype: 'success',
      usage: {},
    })

    // Main turn must still be thinking
    assert.equal(r.isThinking(), true,
      'subagent result must NOT end the main turn (thinking should remain true)')

    // No turn-complete event should have fired
    const turnCompleteEvs = dispatched.filter((e) => e.type === 'nanocode:turn-complete')
    assert.equal(turnCompleteEvs.length, 0,
      'subagent result must NOT dispatch nanocode:turn-complete')
  })

  it('main turn result (no parent_tool_use_id) still correctly ends the turn after subagent ran', () => {
    const r = makeRenderer()
    // Main turn start
    r._handleEvent({ type: 'system', subtype: 'init', session_id: 's1', tools: [] })
    assert.equal(r.isThinking(), true)

    // Subagent runs and completes
    r._handleEvent({
      type: 'assistant',
      parent_tool_use_id: 'toolu_sa1',
      message: { role: 'assistant', id: 'msg_sa1', content: [{ type: 'text', text: 'sub done' }] },
    })
    r._handleEvent({
      type: 'result',
      parent_tool_use_id: 'toolu_sa1',
      subtype: 'success',
      usage: {},
    })

    // Main turn still active
    assert.equal(r.isThinking(), true, 'still thinking after subagent result')

    // Main turn now actually ends (no parent_tool_use_id)
    r._handleEvent({ type: 'result', subtype: 'success', usage: {} })

    assert.equal(r.isThinking(), false, 'main turn result (no parent) must end thinking')

    const turnCompleteEvs = dispatched.filter((e) => e.type === 'nanocode:turn-complete')
    assert.equal(turnCompleteEvs.length, 1,
      'exactly one turn-complete for the main turn result')
  })
})
