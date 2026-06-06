# Fix 2 Report — Line Mode 4px + Click Sensitivity + Seamless Cycle

Date: 2026-06-06

## Changes Made

### A. Line Mode → 4px Hairline
**File:** `public/style.css`

- Changed `min-height: 44px !important` → `height: 4px !important; min-height: 4px !important; max-height: 4px !important`
- Changed `overflow: hidden` → `overflow: visible` (so `::after` can extend beyond for hit area)
- Removed old `::before` pseudo (was `min-height: 44px`, inflating block height)
- Added `::after` pseudo with `top: -8px; bottom: -8px` = 20px total click target (invisible)
- `::before` kept but set to `width: 0; height: 0` (no-op, prevents flex collapse)
- Background now uses `color-mix` for teal tint instead of flat `var(--bg-secondary)`

**Verified:** `getBoundingClientRect().height === 4` in both test page and real 3001 app.

### B. Click Sensitivity Fix
**File:** `public/js/claude-block-renderer/dom-render.js`

- Removed the `if (cur !== 'line') return` guard from the article-level click/touchend handlers
- Now article click fires cycle in ALL three states (full, header, line)
- Header click still fires via `headerEl.click` with `e.stopPropagation()` — prevents double-fire
- `touchHandled` flag still guards against touch+synthetic-click double-fire

### C. Three-State Seamless Cycle
- Cycle was correct in code: `full → header → line → full`
- Bug was that article click only worked in `line` state — so from `full` mode, clicking
  outside the header area did nothing (header click works, but body area click was blocked)
- Fix: removed the `cur !== 'line'` guard — any click on article body cycles regardless of state

## Verification Results

All tested via `browse` + JS injection:

| Test | Expected | Result |
|------|----------|--------|
| Block height in `line` mode | 4px | **4px ✓** |
| `line → full` | 1 click | **✓** |
| `full → header` | 1 click | **✓** |
| `header → line` | 1 click | **✓** |
| 6-click rapid cycle | full→header→line→full→header→line→full | **✓** |
| Header click no double-fire | goes 1 state, not 2 | **✓** |
| Real 3001 app 4px | injected block height=4 | **✓** |

## Screenshots
- `after-fix2-test-initial.png` — test page showing line/header/full blocks
- `after-fix2-line-mode.png` — after 3 click cycles, log confirms transitions
- `after-fix2-real-app.png` — real 3001 app with injected block (thin teal line at bottom)

## Commit
See git log in `zhining/nanocode-selfresume-bugs` branch.
