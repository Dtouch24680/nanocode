import { before, describe, it } from 'node:test'
import assert from 'node:assert/strict'

function makeElement(tag) {
  const children = []
  const listeners = {}
  const el = {
    tagName: tag.toUpperCase(),
    className: '',
    innerHTML: '',
    hidden: false,
    title: '',
    style: {},
    dataset: {},
    children,
    get scrollHeight() { return 0 },
    get scrollTop() { return 0 },
    set scrollTop(_v) {},
    get clientHeight() { return 0 },
    classList: {
      _set: new Set(),
      add(c) { this._set.add(c) },
      remove(c) { this._set.delete(c) },
      contains(c) { return this._set.has(c) },
      toggle(c, force) {
        if (force === true) this._set.add(c)
        else if (force === false) this._set.delete(c)
        else if (this._set.has(c)) this._set.delete(c)
        else this._set.add(c)
      },
    },
    setAttribute(_k, _v) {},
    getAttribute(_k) { return null },
    appendChild(child) { children.push(child); return child },
    insertBefore(node, ref) {
      const idx = children.indexOf(ref)
      if (idx === -1) children.push(node)
      else children.splice(idx, 0, node)
      return node
    },
    removeChild(child) {
      const idx = children.indexOf(child)
      if (idx !== -1) children.splice(idx, 1)
    },
    querySelector(sel) {
      const cls = sel.startsWith('.') ? sel.slice(1) : null
      if (!cls) return null
      for (const c of children) {
        if (typeof c.className === 'string' && c.className.split(' ').includes(cls)) return c
      }
      return null
    },
    querySelectorAll(sel) {
      const cls = sel.startsWith('.') ? sel.slice(1) : null
      if (!cls) return []
      return children.filter((c) => typeof c.className === 'string' && c.className.split(' ').includes(cls))
    },
    addEventListener(ev, fn) {
      listeners[ev] = listeners[ev] || []
      listeners[ev].push(fn)
    },
    dispatchEvent(ev) {
      for (const fn of listeners[ev.type] || []) fn(ev)
    },
    scrollTo() {},
  }
  return el
}

global.document = {
  createElement: (tag) => makeElement(tag),
  createDocumentFragment: () => makeElement('fragment'),
  createTextNode: (text) => ({ nodeValue: text, parentElement: null }),
  createTreeWalker: () => ({ nextNode: () => null }),
  addEventListener: () => {},
  dispatchEvent: () => {},
  querySelectorAll: () => [],
}
global.NodeFilter = {
  SHOW_TEXT: 4,
  FILTER_ACCEPT: 1,
  FILTER_REJECT: 2,
}
global.requestAnimationFrame = (fn) => { fn(); return 0 }
global.location = { protocol: 'http:', host: 'localhost:3001' }
global.WebSocket = class {
  constructor() {}
  set onopen(_v) {}
  set onmessage(_v) {}
  set onerror(_v) {}
  set onclose(_v) {}
  close() {}
}
global.fetch = async () => ({ ok: true, json: async () => ({}) })

let ClaudeBlockRenderer
before(async () => {
  const mod = await import('../../public/js/claude-block-renderer.js')
  ClaudeBlockRenderer = mod.ClaudeBlockRenderer
})

function makeRenderer() {
  const container = makeElement('div')
  return new ClaudeBlockRenderer(container, {})
}

describe('ClaudeBlockRenderer transport replay dedup', () => {
  it('skips a replayed user event when replay_id matches even if the uuid differs', () => {
    const renderer = makeRenderer()
    renderer._replayedTransportKeys.add('user:abc:1')

    renderer._handleEvent({
      type: 'user',
      uuid: 'ws-user-uuid',
      replay_id: 'user:abc:1',
      message: { role: 'user', content: [{ type: 'text', text: 'same message' }] },
    })

    assert.equal(renderer._scroll.children.length, 0)
  })

  it('renders repeated user text when replay_id differs', () => {
    const renderer = makeRenderer()
    renderer._replayedTransportKeys.add('user:abc:1')

    renderer._handleEvent({
      type: 'user',
      uuid: 'ws-user-uuid-2',
      replay_id: 'user:abc:2',
      message: { role: 'user', content: [{ type: 'text', text: 'same message' }] },
    })

    assert.equal(renderer._scroll.children.length, 1)
    assert.ok(renderer._scroll.children[0].innerHTML.includes('same message'))
  })
})
