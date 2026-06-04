/**
 * Tests for the interrupt flow: single Esc → showInterruptBlock() inserts
 * a CLI-style "[Request interrupted by user]" block; no dangling ReferenceError
 * from the removed _interruptingAt variable.
 *
 * These tests use a minimal inline DOM stub (no jsdom dependency) because
 * ClaudeBlockRenderer is a browser-side ES module.  The stub is just enough
 * to exercise showInterruptBlock() and the _addSystemBlock helper.
 */

import { describe, it, before } from 'node:test'
import assert from 'node:assert/strict'

// ── Minimal DOM stub ────────────────────────────────────────────────────────
// Only the subset of DOM APIs that ClaudeBlockRenderer constructor + the methods
// under test actually call.  Anything else throws immediately so tests fail fast
// if the code grows new DOM dependencies.

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
    get scrollHeight()  { return 0 },
    get scrollTop()     { return 0 },
    set scrollTop(_v)   {},
    get clientHeight()  { return 0 },
    classList: {
      _set: new Set(),
      add(c)    { this._set.add(c) },
      remove(c) { this._set.delete(c) },
      contains(c) { return this._set.has(c) },
      toggle(c, force) {
        if (force === true) { this._set.add(c) }
        else if (force === false) { this._set.delete(c) }
        else if (this._set.has(c)) { this._set.delete(c) }
        else { this._set.add(c) }
      },
    },
    setAttribute(_k, _v) {},
    getAttribute(_k)     { return null },
    appendChild(child)   { children.push(child); return child },
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
      // Very limited: find first child whose className contains the token after '.'
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
      return children.filter(c => typeof c.className === 'string' && c.className.split(' ').includes(cls))
    },
    addEventListener(ev, fn, _opts) {
      listeners[ev] = listeners[ev] || []
      listeners[ev].push(fn)
    },
    dispatchEvent(ev) {
      const fns = listeners[ev.type] || []
      fns.forEach(f => f(ev))
    },
    // Scroll helpers used by ClaudeBlockRenderer
    scrollTo(_opts) {},
  }
  return el
}

function makeEvent(type, detail) {
  return { type, detail, preventDefault() {}, stopPropagation() {} }
}

// Patch globals so ClaudeBlockRenderer can call document.createElement etc.
global.document = {
  createElement: (tag) => makeElement(tag),
  createDocumentFragment: () => makeElement('fragment'),
  addEventListener: () => {},
  dispatchEvent: () => {},
  querySelectorAll: () => [],
}
global.requestAnimationFrame = (fn) => { fn(); return 0 }
global.location = { protocol: 'http:', host: 'localhost:3001' }
// WebSocket stub: capture and ignore onopen/onmessage etc. without erroring
global.WebSocket = class {
  constructor() {}
  set onopen(_v) {}
  set onmessage(_v) {}
  set onerror(_v) {}
  set onclose(_v) {}
  close() {}
}
global.fetch = async () => ({ ok: true, json: async () => ({}) })

// ── Import the renderer AFTER globals are patched ───────────────────────────
let ClaudeBlockRenderer
before(async () => {
  const mod = await import('../../public/js/claude-block-renderer.js')
  ClaudeBlockRenderer = mod.ClaudeBlockRenderer
})

// ── Helpers ──────────────────────────────────────────────────────────────────
function makeRenderer() {
  const container = makeElement('div')
  // ClaudeBlockRenderer opens a WebSocket in the constructor unless we skip it.
  // Pass no projectId/tabId so it skips the connect() call.
  const renderer = new ClaudeBlockRenderer(container, {})
  return { renderer, container }
}

/** Walk the scroll area and collect all inserted article elements. */
function getBlocks(renderer) {
  return renderer._scroll.children
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('ClaudeBlockRenderer.showInterruptBlock()', () => {
  it('inserts exactly one block with class cbr-block-interrupted', () => {
    const { renderer } = makeRenderer()
    renderer.showInterruptBlock()
    const blocks = getBlocks(renderer)
    const interrupted = blocks.filter(b => b.className.includes('cbr-block-interrupted'))
    assert.equal(interrupted.length, 1, 'Expected exactly 1 interrupted block')
  })

  it('block innerHTML contains the CLI-exact text "[Request interrupted by user]"', () => {
    const { renderer } = makeRenderer()
    renderer.showInterruptBlock()
    const blocks = getBlocks(renderer)
    const block = blocks.find(b => b.className.includes('cbr-block-interrupted'))
    assert.ok(block, 'Interrupted block must exist')
    assert.ok(
      block.innerHTML.includes('[Request interrupted by user]'),
      `Expected "[Request interrupted by user]" in innerHTML, got: ${block.innerHTML}`
    )
  })

  it('block also has cbr-block-system class (reuses system block styling)', () => {
    const { renderer } = makeRenderer()
    renderer.showInterruptBlock()
    const blocks = getBlocks(renderer)
    const block = blocks.find(b => b.className.includes('cbr-block-interrupted'))
    assert.ok(block.className.includes('cbr-block-system'), 'Should share cbr-block-system class')
  })

  it('calling twice inserts two blocks (idempotent add, not de-dup)', () => {
    const { renderer } = makeRenderer()
    renderer.showInterruptBlock()
    renderer.showInterruptBlock()
    const blocks = getBlocks(renderer)
    const interrupted = blocks.filter(b => b.className.includes('cbr-block-interrupted'))
    assert.equal(interrupted.length, 2)
  })
})

describe('sendRaw("\\x03") uses showInterruptBlock (not the old text)', () => {
  it('appends block with new CLI text, not old "[interrupting…]" text', () => {
    const { renderer } = makeRenderer()
    // sendRaw also calls fetch — that's fine with the global stub above.
    renderer.sendRaw('\x03')
    const blocks = getBlocks(renderer)
    const block = blocks.find(b => b.className.includes('cbr-block-interrupted'))
    assert.ok(block, 'sendRaw("\\x03") must insert interrupted block')
    assert.ok(
      block.innerHTML.includes('[Request interrupted by user]'),
      'Old text "[interrupting…]" must be gone; expected CLI text'
    )
    assert.ok(
      !block.innerHTML.includes('interrupting…'),
      'Old "[interrupting…]" text must not appear'
    )
  })
})

describe('No dangling _interruptingAt reference in terminal-view.js', () => {
  it('grep confirms _interruptingAt is not referenced anywhere in the codebase', async () => {
    // Use Node.js fs to grep — keeps this self-contained without shell injection.
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const tvPath = join(new URL('../../public/js/terminal-view.js', import.meta.url).pathname)
    const cbrPath = join(new URL('../../public/js/claude-block-renderer.js', import.meta.url).pathname)
    const tvSrc = readFileSync(tvPath, 'utf8')
    const cbrSrc = readFileSync(cbrPath, 'utf8')
    assert.ok(
      !tvSrc.includes('_interruptingAt'),
      'terminal-view.js must not reference _interruptingAt'
    )
    assert.ok(
      !cbrSrc.includes('_interruptingAt'),
      'claude-block-renderer.js must not reference _interruptingAt'
    )
  })

  it('grep confirms FORCE_WINDOW_MS is not referenced anywhere', async () => {
    const { readFileSync } = await import('node:fs')
    const tvPath = new URL('../../public/js/terminal-view.js', import.meta.url).pathname
    const tvSrc = readFileSync(tvPath, 'utf8')
    assert.ok(!tvSrc.includes('FORCE_WINDOW'), 'terminal-view.js must not reference FORCE_WINDOW')
  })

  it('grep confirms isForce is not referenced in terminal-view.js', async () => {
    const { readFileSync } = await import('node:fs')
    const tvPath = new URL('../../public/js/terminal-view.js', import.meta.url).pathname
    const tvSrc = readFileSync(tvPath, 'utf8')
    assert.ok(!tvSrc.includes('isForce'), 'terminal-view.js must not reference isForce')
  })
})
