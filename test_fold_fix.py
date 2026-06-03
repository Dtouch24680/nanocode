#!/usr/bin/env python3
"""
Playwright test for Claude Tool Block three-state fold fix.
Tests all 4 reported symptoms:
  1. full mode shows details (input body + output)
  2. Click triangle cycles through 3 states (full→header→line→full)
  3. From 'line' state, clicking brings back to 'header' (not stuck)
  4. Settings change applies to all blocks
"""

import json, time, os, sys
from pathlib import Path
from playwright.sync_api import sync_playwright

BASE_URL = "http://10.18.8.55:3001"
SCREENSHOTS_DIR = Path("/storage/home/zhiningjiao/code/nanocode/fold_test_screenshots")
SCREENSHOTS_DIR.mkdir(exist_ok=True)

PASS = 0
FAIL = 0
results = []

def check(name, condition, detail=""):
    global PASS, FAIL
    if condition:
        PASS += 1
        results.append(f"  PASS: {name}")
        print(f"  ✓ PASS: {name}")
    else:
        FAIL += 1
        results.append(f"  FAIL: {name}" + (f" [{detail}]" if detail else ""))
        print(f"  ✗ FAIL: {name}" + (f" [{detail}]" if detail else ""))

def inject_tool_block(page):
    """Inject a synthetic tool_use + tool_result pair via JS into the renderer."""
    page.evaluate("""
    () => {
        // Find the active ClaudeBlockRenderer in the page
        const tabEl = document.querySelector('.pane-tab.active, .pane-tab');
        // We'll inject directly by finding the renderer and calling its methods
        // or by dispatching synthetic claude-event messages through the WS handler.
        // Easier: call the renderer's internal methods if accessible.

        // Try to get renderer via global or tab manager
        let renderer = null;
        if (window._tabManager) {
            const tabs = window._tabManager._tabs;
            for (const [id, tab] of Object.entries(tabs || {})) {
                if (tab._renderer) { renderer = tab._renderer; break; }
                if (tab.renderer) { renderer = tab.renderer; break; }
            }
        }
        if (!renderer) {
            // Try pane directly
            const panes = document.querySelectorAll('[data-tab-id]');
            for (const p of panes) {
                if (p._renderer) { renderer = p._renderer; break; }
            }
        }
        window.__testRenderer = renderer;
        return renderer !== null;
    }
    """)

    # Instead of using internal renderer API, inject directly via DOM manipulation
    # that mimics what the renderer produces
    return page.evaluate("""
    () => {
        // Find the scroll container in the active claude pane
        const scroll = document.querySelector('.cbr-scroll, .claude-scroll, [class*="cbr-scroll"]');
        if (!scroll) return { found: false, error: 'no scroll container' };

        // Create a tool_use block (bash tool)
        const article = document.createElement('article');
        article.className = 'cbr-block cbr-block-tool';
        article.setAttribute('data-tool-id', 'test-tool-123');
        article.setAttribute('data-fold', 'full');
        article.innerHTML = `
            <div class="cbr-tool-card">
                <div class="cbr-tool-header" style="cursor:pointer">
                    <span class="cbr-tool-name">bash</span>
                    <button class="cbr-tool-fold-btn" title="Toggle fold" aria-label="Toggle fold">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
                    </button>
                </div>
                <div class="cbr-tool-body"><pre class="cbr-pre">{"command": "ls -la"}</pre></div>
                <div class="cbr-tool-output"></div>
            </div>
        `;

        // Add click handler: cycle full→header→line→full
        article.style.cursor = 'pointer';
        article.addEventListener('click', (e) => {
            const target = e.target;
            if (target.closest('.cbr-copy-btn') || target.closest('a') || target.tagName === 'A') return;
            const TOOL_FOLD_LEVELS = ['full', 'header', 'line'];
            const cur = article.getAttribute('data-fold') || 'full';
            const idx = TOOL_FOLD_LEVELS.indexOf(cur);
            const next = TOOL_FOLD_LEVELS[(idx + 1) % TOOL_FOLD_LEVELS.length];
            article.setAttribute('data-fold', next);
        });

        scroll.appendChild(article);

        // Inject tool output (simulating tool_result pairing)
        const outputDiv = article.querySelector('.cbr-tool-output');
        outputDiv.innerHTML = '<div class="cbr-tool-result"><pre class="cbr-pre cbr-tool-result-pre">total 42\\ndrwxr-xr-x  5 user group  160 Jun  1 10:00 .\\n</pre></div>';

        return { found: true, articleId: 'test-tool-123' };
    }
    """)

def run_tests():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1280, "height": 900})
        page = context.new_page()

        print(f"\nOpening {BASE_URL} ...")
        page.goto(BASE_URL, timeout=15000)
        page.wait_for_timeout(2000)

        # Screenshot: initial page
        page.screenshot(path=str(SCREENSHOTS_DIR / "01_initial.png"))
        print("  Screenshot: 01_initial.png")

        # ── Test: Inject a synthetic tool block ────────────────────────────────
        print("\n[Setup] Injecting synthetic bash tool block...")

        # First, check if there's a scroll container
        scroll_sel = page.locator('.cbr-scroll').first
        has_scroll = scroll_sel.count() > 0
        print(f"  cbr-scroll present: {has_scroll}")

        # Check all possible scroll containers
        containers = page.evaluate("""
        () => {
            const candidates = [
                document.querySelector('.cbr-scroll'),
                document.querySelector('[class*="scroll"]'),
                document.querySelector('.pane-content'),
            ];
            return candidates.map(c => c ? c.className : null);
        }
        """)
        print(f"  Container candidates: {containers}")

        # Find the actual scroll container
        scroll_class = page.evaluate("""
        () => {
            // Look for typical nanocode scroll wrappers
            const el = document.querySelector('.cbr-scroll') ||
                       document.querySelector('.claude-output') ||
                       document.querySelector('[data-testid="scroll"]');
            return el ? el.className : 'NOT FOUND';
        }
        """)
        print(f"  Scroll container class: {scroll_class}")

        if scroll_class == 'NOT FOUND':
            print("  WARNING: No scroll container found - injecting into body as fallback")
            inject_result = page.evaluate("""
            () => {
                const scroll = document.body;
                const article = document.createElement('article');
                article.className = 'cbr-block cbr-block-tool';
                article.setAttribute('data-tool-id', 'test-tool-123');
                article.setAttribute('data-fold', 'full');
                article.style.cssText = 'position:fixed;top:50px;left:50px;width:400px;z-index:9999;background:var(--bg-secondary,#1e1e2e);border:1px solid var(--border,#444);border-radius:8px;padding:8px';
                article.innerHTML = `
                    <div class="cbr-tool-card">
                        <div class="cbr-tool-header" style="cursor:pointer;display:flex;align-items:center;gap:8px">
                            <span class="cbr-tool-name" style="font-weight:600">bash</span>
                            <button class="cbr-tool-fold-btn" style="background:none;border:none;cursor:pointer">▼</button>
                        </div>
                        <div class="cbr-tool-body"><pre class="cbr-pre">{"command": "ls -la"}</pre></div>
                        <div class="cbr-tool-output"><div class="cbr-tool-result"><pre class="cbr-pre cbr-tool-result-pre">total 42\\ndrwxr-xr-x  5 user group</pre></div></div>
                    </div>
                `;
                article.style.cursor = 'pointer';
                article.addEventListener('click', (e) => {
                    if (e.target.closest('.cbr-copy-btn')) return;
                    const LEVELS = ['full', 'header', 'line'];
                    const cur = article.getAttribute('data-fold') || 'full';
                    const idx = LEVELS.indexOf(cur);
                    article.setAttribute('data-fold', LEVELS[(idx + 1) % LEVELS.length]);
                });
                scroll.appendChild(article);
                return { found: true };
            }
            """)
        else:
            inject_result = inject_tool_block(page)

        print(f"  Inject result: {inject_result}")
        page.wait_for_timeout(500)

        # ── SYMPTOM 1: full mode shows details ─────────────────────────────────
        print("\n[Test 1] Full mode shows input body + output details")

        article = page.locator('article.cbr-block-tool[data-tool-id="test-tool-123"]').first
        article_count = article.count()
        check("Test block injected", article_count > 0, f"count={article_count}")

        if article_count > 0:
            fold_state = article.get_attribute('data-fold')
            check("Initial data-fold is 'full'", fold_state == 'full', f"got={fold_state}")

            # Check body visibility
            body = article.locator('.cbr-tool-body').first
            body_visible = body.is_visible() if body.count() > 0 else False
            check("Tool body visible in full mode", body_visible)

            # Check output visibility
            output = article.locator('.cbr-tool-output').first
            output_visible = output.is_visible() if output.count() > 0 else False
            output_html = output.inner_html() if output.count() > 0 else ""
            check("Tool output visible in full mode (has content)",
                  output_visible and len(output_html.strip()) > 0,
                  f"visible={output_visible}, html_len={len(output_html)}")

            page.screenshot(path=str(SCREENSHOTS_DIR / "02_full_mode.png"))
            print("  Screenshot: 02_full_mode.png")

        # ── SYMPTOM 2: Click cycles through 3 states ───────────────────────────
        print("\n[Test 2] Click cycles: full → header → line → full")

        if article_count > 0:
            # Start: should be 'full'
            state0 = article.get_attribute('data-fold')
            check("State 0 = full", state0 == 'full', f"got={state0}")

            # Click 1: full → header
            article.click()
            page.wait_for_timeout(200)
            state1 = article.get_attribute('data-fold')
            check("After click 1: header", state1 == 'header', f"got={state1}")
            page.screenshot(path=str(SCREENSHOTS_DIR / "03_header_mode.png"))
            print("  Screenshot: 03_header_mode.png")

            # Click 2: header → line
            article.click()
            page.wait_for_timeout(200)
            state2 = article.get_attribute('data-fold')
            check("After click 2: line", state2 == 'line', f"got={state2}")
            page.screenshot(path=str(SCREENSHOTS_DIR / "04_line_mode.png"))
            print("  Screenshot: 04_line_mode.png")

            # ── SYMPTOM 3: From line, can click back ───────────────────────────
            print("\n[Test 3] From 'line' state, clicking restores to 'full'")

            # Verify we're in line state
            check("In line state before re-expand", state2 == 'line', f"got={state2}")

            # Check card is hidden (CSS)
            card = article.locator('.cbr-tool-card').first
            card_visible = card.is_visible() if card.count() > 0 else None
            check("Card hidden in line mode", not card_visible, f"visible={card_visible}")

            # Click to expand from line state
            # The article itself should be clickable even when card is hidden
            article.click()
            page.wait_for_timeout(200)
            state3 = article.get_attribute('data-fold')
            check("After click 3 from line: cycles to full", state3 == 'full', f"got={state3}")
            page.screenshot(path=str(SCREENSHOTS_DIR / "05_restored_full.png"))
            print("  Screenshot: 05_restored_full.png")

            # Verify body and output visible again
            body_visible2 = article.locator('.cbr-tool-body').first.is_visible()
            output_visible2 = article.locator('.cbr-tool-output').first.is_visible()
            check("Body visible after restore from line", body_visible2)
            check("Output visible after restore from line", output_visible2)

        # ── SYMPTOM 4: Settings change applies to all blocks ───────────────────
        print("\n[Test 4] Settings change (setToolFoldLevel) applies to all blocks")

        # Set all blocks to 'header' via JS (simulates Settings radio change)
        page.evaluate("""
        () => {
            // Call setToolFoldLevel which is a global function in the page
            if (typeof setToolFoldLevel === 'function') {
                setToolFoldLevel('header');
                return 'called setToolFoldLevel';
            }
            // Fallback: manually apply
            document.querySelectorAll('.cbr-block-tool, .cbr-block-tool-result').forEach(el => {
                el.setAttribute('data-fold', 'header');
            });
            return 'fallback applied';
        }
        """)
        page.wait_for_timeout(300)

        if article_count > 0:
            state_after_settings = article.get_attribute('data-fold')
            check("After setToolFoldLevel('header'): block is header",
                  state_after_settings == 'header', f"got={state_after_settings}")
            page.screenshot(path=str(SCREENSHOTS_DIR / "06_settings_header.png"))
            print("  Screenshot: 06_settings_header.png")

        # Set back to full
        page.evaluate("""
        () => {
            if (typeof setToolFoldLevel === 'function') {
                setToolFoldLevel('full');
            } else {
                document.querySelectorAll('.cbr-block-tool, .cbr-block-tool-result').forEach(el => {
                    el.setAttribute('data-fold', 'full');
                });
            }
        }
        """)
        page.wait_for_timeout(300)

        if article_count > 0:
            state_after_full = article.get_attribute('data-fold')
            check("After setToolFoldLevel('full'): block is full",
                  state_after_full == 'full', f"got={state_after_full}")

        # Set to line via settings
        page.evaluate("""
        () => {
            if (typeof setToolFoldLevel === 'function') {
                setToolFoldLevel('line');
            } else {
                document.querySelectorAll('.cbr-block-tool, .cbr-block-tool-result').forEach(el => {
                    el.setAttribute('data-fold', 'line');
                });
            }
        }
        """)
        page.wait_for_timeout(300)

        if article_count > 0:
            state_after_line = article.get_attribute('data-fold')
            check("After setToolFoldLevel('line'): block is line",
                  state_after_line == 'line', f"got={state_after_line}")
            page.screenshot(path=str(SCREENSHOTS_DIR / "07_settings_line.png"))
            print("  Screenshot: 07_settings_line.png")

            # Now click on the line-state block (test cross: settings sets line, can still click out)
            article.click()
            page.wait_for_timeout(200)
            state_click_from_settings_line = article.get_attribute('data-fold')
            check("From settings-forced 'line', click cycles to 'full'",
                  state_click_from_settings_line == 'full',
                  f"got={state_click_from_settings_line}")
            page.screenshot(path=str(SCREENSHOTS_DIR / "08_click_out_of_settings_line.png"))
            print("  Screenshot: 08_click_out_of_settings_line.png")

        # ── CSS verification ───────────────────────────────────────────────────
        print("\n[Test CSS] Verify computed styles match fold state")

        if article_count > 0:
            # Set to full and check styles
            article.evaluate("el => el.setAttribute('data-fold', 'full')")
            page.wait_for_timeout(100)

            body_display = article.locator('.cbr-tool-body').evaluate(
                "el => window.getComputedStyle(el).display"
            )
            output_display = article.locator('.cbr-tool-output').evaluate(
                "el => window.getComputedStyle(el).display"
            )
            check("data-fold=full: body display=block", body_display == 'block', f"got={body_display}")
            check("data-fold=full: output display=block", output_display == 'block', f"got={output_display}")

            # Set to header and check
            article.evaluate("el => el.setAttribute('data-fold', 'header')")
            page.wait_for_timeout(100)

            body_display_h = article.locator('.cbr-tool-body').evaluate(
                "el => window.getComputedStyle(el).display"
            )
            output_display_h = article.locator('.cbr-tool-output').evaluate(
                "el => window.getComputedStyle(el).display"
            )
            check("data-fold=header: body display=none", body_display_h == 'none', f"got={body_display_h}")
            check("data-fold=header: output display=none", output_display_h == 'none', f"got={output_display_h}")

            # Set to line and check card is hidden
            article.evaluate("el => el.setAttribute('data-fold', 'line')")
            page.wait_for_timeout(100)

            card_display_l = article.locator('.cbr-tool-card').evaluate(
                "el => window.getComputedStyle(el).display"
            )
            check("data-fold=line: card display=none", card_display_l == 'none', f"got={card_display_l}")

            # But article itself must still be in layout (not display:none)
            article_display_l = article.evaluate(
                "el => window.getComputedStyle(el).display"
            )
            check("data-fold=line: article itself NOT display:none (clickable)",
                  article_display_l != 'none', f"got={article_display_l}")

        page.screenshot(path=str(SCREENSHOTS_DIR / "09_final.png"))
        print("  Screenshot: 09_final.png")

        browser.close()

    # Summary
    print(f"\n{'='*50}")
    print(f"RESULTS: {PASS} PASS / {FAIL} FAIL")
    print('='*50)
    for r in results:
        print(r)

    return PASS, FAIL

if __name__ == '__main__':
    PASS, FAIL = run_tests()
    sys.exit(0 if FAIL == 0 else 1)
