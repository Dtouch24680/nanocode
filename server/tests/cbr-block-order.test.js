import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { chromium } from 'playwright'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '../..')
const PUBLIC = path.join(ROOT, 'public')
const HARNESS = path.join(__dirname, 'fixtures', 'cbr-order-harness.html')

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.map': 'application/json',
}

// Static server: serves public/, plus /harness -> the test fixture html.
function startServer() {
  const server = http.createServer((req, res) => {
    let urlPath = decodeURIComponent(req.url.split('?')[0])
    let filePath
    if (urlPath === '/harness') {
      filePath = HARNESS
    } else {
      filePath = path.join(PUBLIC, urlPath)
    }
    if (!existsSync(filePath)) {
      res.statusCode = 404
      res.end('not found')
      return
    }
    const ext = path.extname(filePath)
    res.setHeader('Content-Type', MIME[ext] || 'application/octet-stream')
    res.end(readFileSync(filePath))
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server))
  })
}

// Build a history event stream that mimics a Claude turn doing TWO sequential
// tool calls (e.g. two parallel Read), each persisted as its own assistant row
// sharing the SAME requestId, followed by a final conclusion text.
// This is the shape parseJsonlHistory produces from a real jsonl after the
// requestId:firstType dedup. The bug under test: the FIRST tool_use must not be
// dropped, and the conclusion text must render LAST (after both tool blocks).
function parallelToolHistory() {
  return [
    { type: 'user', message: { role: 'user', content: 'Read both files' } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: "I'll read both files in parallel." }] } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/a' } }] } },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'AAA' }] } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't2', name: 'Read', input: { file_path: '/b' } }] } },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', content: 'BBB' }] } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'CONCLUSION: both files read.' }] } },
  ]
}

describe('cbr block order (history replay)', () => {
  let server, browser, baseURL

  before(async () => {
    server = await startServer()
    const { port } = server.address()
    baseURL = `http://127.0.0.1:${port}`
    browser = await chromium.launch()
  })

  after(async () => {
    if (browser) await browser.close()
    if (server) await new Promise((r) => server.close(r))
  })

  async function renderOrder(viewport) {
    const ctx = await browser.newContext({ viewport })
    const page = await ctx.newPage()
    await page.goto(`${baseURL}/harness`)
    await page.waitForFunction(() => typeof window.__replay === 'function')
    await page.evaluate((events) => window.__replay(events), parallelToolHistory())
    const order = await page.evaluate(() => window.__blockOrder())
    await ctx.close()
    return order
  }

  it('renders both tool blocks before the conclusion on desktop (1280x860)', async () => {
    const order = await renderOrder({ width: 1280, height: 860 })
    const kinds = order.map((b) => b.kind)
    // Every tool / tool-result block must come BEFORE the conclusion text block.
    const concludeIdx = order.findIndex((b) => b.kind === 'text' && /CONCLUSION/.test(b.text))
    assert.ok(concludeIdx >= 0, `conclusion text block missing; got ${JSON.stringify(order)}`)
    const toolIdxs = kinds.map((k, i) => (k.startsWith('tool') ? i : -1)).filter((i) => i >= 0)
    assert.ok(toolIdxs.length >= 2, `expected at least 2 tool blocks; got ${JSON.stringify(order)}`)
    for (const ti of toolIdxs) {
      assert.ok(ti < concludeIdx, `tool block at ${ti} rendered AFTER conclusion at ${concludeIdx}; order=${JSON.stringify(order)}`)
    }
    // The first Read tool_use (#t1) must not be dropped: at least two real tool blocks.
    const realToolBlocks = kinds.filter((k) => k === 'tool').length
    assert.ok(realToolBlocks >= 2, `first tool_use was dropped; only ${realToolBlocks} tool block(s) in ${JSON.stringify(order)}`)
  })

  it('renders identical block order on mobile (390x844)', async () => {
    const desktop = (await renderOrder({ width: 1280, height: 860 })).map((b) => b.kind)
    const mobile = (await renderOrder({ width: 390, height: 844 })).map((b) => b.kind)
    assert.deepEqual(mobile, desktop, `mobile order ${JSON.stringify(mobile)} != desktop ${JSON.stringify(desktop)}`)
  })
})
