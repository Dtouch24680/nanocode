/**
 * Playwright test: Tool Block Fold Level — computed style verification
 *
 * Tests the three-level fold (full / header / line) using REAL computed styles
 * in a headless Chromium, not just localStorage/attribute assertions.
 *
 * Serves the real style.css + real claude-block-renderer.js via static server.
 */

import { chromium } from 'playwright'
import { createServer } from 'http'
import { readFileSync, existsSync } from 'fs'
import { extname, join, resolve } from 'path'
import { fileURLToPath } from 'url'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const REPO_ROOT = resolve(__dirname, '..')

const MIME = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
}

// ── Static server ─────────────────────────────────────────────────────────────
function startServer(port) {
  return new Promise((res) => {
    const server = createServer((req, resp) => {
      // Serve files relative to REPO_ROOT
      let path = req.url.split('?')[0]
      if (path === '/') path = '/qa-test/fold-harness.html'
      const fullPath = join(REPO_ROOT, path)
      if (!existsSync(fullPath)) {
        resp.writeHead(404)
        resp.end('Not found: ' + fullPath)
        return
      }
      const ext = extname(fullPath)
      resp.writeHead(200, {
        'Content-Type': MIME[ext] || 'text/plain',
        // Allow ES module imports
        'Access-Control-Allow-Origin': '*',
      })
      resp.end(readFileSync(fullPath))
    })
    server.listen(port, '127.0.0.1', () => res(server))
  })
}

// ── Test helpers ──────────────────────────────────────────────────────────────
let passed = 0
let failed = 0
const evidence = []

function assert(cond, label, detail = '') {
  if (cond) {
    console.log(`  PASS: ${label}`)
    passed++
    evidence.push(`PASS: ${label}${detail ? ' | ' + detail : ''}`)
  } else {
    console.error(`  FAIL: ${label}${detail ? ' | ' + detail : ''}`)
    failed++
    evidence.push(`FAIL: ${label}${detail ? ' | ' + detail : ''}`)
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
const PORT = 17443
const server = await startServer(PORT)
const browser = await chromium.launch({ headless: true })
const page = await browser.newPage()

// Capture JS errors from page
page.on('pageerror', (err) => console.error('[PAGE ERROR]', err.message))
page.on('console', (msg) => {
  if (msg.type() === 'error') console.error('[CONSOLE ERROR]', msg.text())
})

try {
  await page.goto(`http://127.0.0.1:${PORT}/qa-test/fold-harness.html`)
  await page.waitForSelector('[data-harness-ready="true"]', { timeout: 10000 })

  const status = await page.textContent('#status')
  console.log('Harness status:', status)

  // ── Verify blocks were rendered ─────────────────────────────────────────────
  const toolBlockCount = await page.locator('.cbr-block-tool').count()
  const toolResultCount = await page.locator('.cbr-block-tool-result').count()
  console.log(`\nBlocks rendered: tool=${toolBlockCount}, tool_result=${toolResultCount}`)
  assert(toolBlockCount >= 1, 'At least 1 tool_use block rendered')
  assert(toolResultCount >= 1, 'At least 1 tool_result block rendered')

  // ── Helper to gather computed styles for all relevant blocks ─────────────────
  async function gatherStyles() {
    return page.evaluate(() => {
      const results = []

      // Tool use blocks
      document.querySelectorAll('.cbr-block-tool').forEach((block, i) => {
        const body = block.querySelector('.cbr-tool-body')
        const card = block.querySelector('.cbr-tool-card')
        results.push({
          kind: 'tool',
          index: i,
          dataFold: block.getAttribute('data-fold'),
          blockDisplay: getComputedStyle(block).display,
          bodyDisplay: body ? getComputedStyle(body).display : 'NO_BODY',
          cardDisplay: card ? getComputedStyle(card).display : 'NO_CARD',
          bodyContent: body ? body.textContent.trim().slice(0, 50) : '',
        })
      })

      // Tool result blocks
      document.querySelectorAll('.cbr-block-tool-result').forEach((block, i) => {
        const result = block.querySelector('.cbr-tool-result')
        results.push({
          kind: 'tool_result',
          index: i,
          dataFold: block.getAttribute('data-fold'),
          blockDisplay: getComputedStyle(block).display,
          resultDisplay: result ? getComputedStyle(result).display : 'NO_RESULT',
          resultContent: result ? result.textContent.trim().slice(0, 50) : '',
        })
      })

      return results
    })
  }

  // ── Test: FULL level (default) ──────────────────────────────────────────────
  console.log('\n=== Testing FULL level ===')
  await page.evaluate(() => window.harnessAPI.setToolFoldLevel('full'))
  await page.waitForTimeout(100) // allow style recalc

  const fullStyles = await gatherStyles()
  console.log('Full styles:', JSON.stringify(fullStyles, null, 2))

  for (const s of fullStyles) {
    if (s.kind === 'tool') {
      assert(s.dataFold === 'full', `Tool[${s.index}] data-fold is 'full'`, `got: ${s.dataFold}`)
      assert(s.bodyDisplay !== 'none', `Tool[${s.index}] .cbr-tool-body visible (not none) at full`, `got: ${s.bodyDisplay}`)
      assert(s.bodyContent.length > 0, `Tool[${s.index}] .cbr-tool-body has content at full`, `got: "${s.bodyContent}"`)
    }
    if (s.kind === 'tool_result') {
      assert(s.dataFold === 'full', `ToolResult[${s.index}] data-fold is 'full'`, `got: ${s.dataFold}`)
      assert(s.resultDisplay !== 'none', `ToolResult[${s.index}] .cbr-tool-result visible at full`, `got: ${s.resultDisplay}`)
      assert(s.resultContent.length > 0, `ToolResult[${s.index}] has text content at full`, `got: "${s.resultContent}"`)
    }
  }

  // ── Test: HEADER level ──────────────────────────────────────────────────────
  console.log('\n=== Testing HEADER level ===')
  await page.evaluate(() => window.harnessAPI.setToolFoldLevel('header'))
  await page.waitForTimeout(100)

  const headerStyles = await gatherStyles()
  console.log('Header styles:', JSON.stringify(headerStyles, null, 2))

  for (const s of headerStyles) {
    if (s.kind === 'tool') {
      assert(s.dataFold === 'header', `Tool[${s.index}] data-fold is 'header'`, `got: ${s.dataFold}`)
      assert(s.bodyDisplay === 'none', `Tool[${s.index}] .cbr-tool-body hidden (none) at header`, `got: ${s.bodyDisplay}`)
      assert(s.blockDisplay !== 'none', `Tool[${s.index}] block itself visible at header`, `got: ${s.blockDisplay}`)
    }
    if (s.kind === 'tool_result') {
      assert(s.dataFold === 'header', `ToolResult[${s.index}] data-fold is 'header'`, `got: ${s.dataFold}`)
      assert(s.resultDisplay === 'none', `ToolResult[${s.index}] .cbr-tool-result hidden at header`, `got: ${s.resultDisplay}`)
    }
  }

  // ── Test: LINE level ────────────────────────────────────────────────────────
  console.log('\n=== Testing LINE level ===')
  await page.evaluate(() => window.harnessAPI.setToolFoldLevel('line'))
  await page.waitForTimeout(100)

  const lineStyles = await gatherStyles()
  console.log('Line styles:', JSON.stringify(lineStyles, null, 2))

  for (const s of lineStyles) {
    if (s.kind === 'tool') {
      assert(s.dataFold === 'line', `Tool[${s.index}] data-fold is 'line'`, `got: ${s.dataFold}`)
      assert(s.cardDisplay === 'none', `Tool[${s.index}] .cbr-tool-card hidden at line`, `got: ${s.cardDisplay}`)
    }
    if (s.kind === 'tool_result') {
      assert(s.dataFold === 'line', `ToolResult[${s.index}] data-fold is 'line'`, `got: ${s.dataFold}`)
      assert(s.resultDisplay === 'none', `ToolResult[${s.index}] .cbr-tool-result hidden at line`, `got: ${s.resultDisplay}`)
    }
  }

  // ── Test: Switch back to FULL ───────────────────────────────────────────────
  console.log('\n=== Testing switch back to FULL (verifies no stuck state) ===')
  await page.evaluate(() => window.harnessAPI.setToolFoldLevel('full'))
  await page.waitForTimeout(100)

  const backToFullStyles = await gatherStyles()
  for (const s of backToFullStyles) {
    if (s.kind === 'tool') {
      assert(s.bodyDisplay !== 'none', `Tool[${s.index}] body visible again after switching back to full`, `got: ${s.bodyDisplay}`)
    }
    if (s.kind === 'tool_result') {
      assert(s.resultDisplay !== 'none', `ToolResult[${s.index}] result visible again after switching back to full`, `got: ${s.resultDisplay}`)
    }
  }

  // ── Screenshot ───────────────────────────────────────────────────────────────
  // Switch to header to show the visual difference, then screenshot
  await page.evaluate(() => window.harnessAPI.setToolFoldLevel('header'))
  await page.waitForTimeout(100)
  await page.screenshot({ path: join(__dirname, 'fold-header-screenshot.png'), fullPage: true })
  console.log('\nScreenshot saved: qa-test/fold-header-screenshot.png')

  await page.evaluate(() => window.harnessAPI.setToolFoldLevel('line'))
  await page.waitForTimeout(100)
  await page.screenshot({ path: join(__dirname, 'fold-line-screenshot.png'), fullPage: true })
  console.log('Screenshot saved: qa-test/fold-line-screenshot.png')

  await page.evaluate(() => window.harnessAPI.setToolFoldLevel('full'))
  await page.waitForTimeout(100)
  await page.screenshot({ path: join(__dirname, 'fold-full-screenshot.png'), fullPage: true })
  console.log('Screenshot saved: qa-test/fold-full-screenshot.png')

} catch (err) {
  console.error('Fatal test error:', err)
  failed++
} finally {
  await browser.close()
  server.close()
}

// ── Report ────────────────────────────────────────────────────────────────────
console.log(`\n${'='.repeat(60)}`)
console.log(`Results: PASS=${passed} FAIL=${failed}`)
console.log('='.repeat(60))
console.log('\nEvidence:')
evidence.forEach((e) => console.log(' ', e))

process.exit(failed > 0 ? 1 : 0)
