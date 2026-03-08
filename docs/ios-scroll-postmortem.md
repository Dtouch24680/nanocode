# Postmortem: iOS Scrolling Bugs in Mobile Terminal Interface

**Date**: 2026-02-14
**Status**: Resolved
**Severity**: High — rendered mobile interface unusable on iOS

## Summary

After implementing the mobile-friendly terminal interface (stacked panes, touch toolbar, swipe navigation), three distinct iOS scrolling bugs surfaced during real-device testing on iPhone (Safari and Chrome). Each had a different root cause and required a separate fix. The bugs were resolved over three iterations.

## Timeline

1. **Mobile interface deployed** — layout worked, but three scrolling issues emerged on iOS devices.
2. **Bug 1 identified** — swiping between panes or tapping session tabs triggered the iOS keyboard, which scrolled the page up.
3. **Bug 2 identified** — after fixing Bug 1, the browser page scrollbar activated instead of the terminal scrollbar when touch-scrolling terminal content.
4. **Bug 3 identified** — after fixing Bug 2, tapping the input textarea caused iOS Chrome to scroll the document down, leaving a large blank space below the input bar.
5. **All three bugs resolved** — mobile interface fully functional on iOS Safari and Chrome.

## Bug 1: Programmatic `focus()` Opens iOS Keyboard and Scrolls Page

### Symptom

Swiping between Bash/Claude panes or tapping session tabs caused iOS to open the virtual keyboard and scroll the entire page upward.

### Root Cause

The `setMode()` function called `chatInput.focus()` unconditionally after switching panes. On desktop this is harmless. On iOS, programmatic `.focus()` on a text input opens the virtual keyboard, and iOS scrolls the focused element into view — displacing the entire fixed layout.

The touch toolbar handler had the same issue: it called `chatInput.focus()` after every button tap.

### Fix

- Guarded `chatInput.focus()` in `setMode()` with `if (!isMobile())`.
- Changed the touch toolbar handler from unconditional `chatInput.focus()` to `if (document.activeElement === chatInput) chatInput.focus()` — only re-focus if the keyboard was already open.

**Files**: `terminal/public/js/app.js`

## Bug 2: iOS Scrolls the Page Instead of the Terminal

### Symptom

Touch-scrolling inside a terminal pane scrolled the browser page (creating visible overscroll bounce) instead of scrolling the terminal content.

### Root Cause

Two compounding issues:

1. **`overflow: hidden` on `<body>` is insufficient on iOS.** iOS Safari can scroll the `<html>` element even when `<body>` has `overflow: hidden`. The page needs both `<html>` and `<body>` to have `position: fixed; width: 100%; overflow: hidden` to truly lock scrolling.

2. **xterm.js sets inline `touch-action: none` on `.xterm-screen`.** This blocks all touch gestures including the ones we need for terminal scrolling. CSS `!important` cannot reliably override inline styles set by JavaScript. The terminal's built-in touch handling doesn't work well on iOS.

### Fix

Three changes:

- **CSS**: Added `position: fixed; width: 100%; overflow: hidden` on both `html` and `body` in the `@media (max-width: 768px)` block. Added `overscroll-behavior: none` on `html, body` globally.
- **JS (`terminal-pane.js`)**: Added `_initTouchScroll(container)` method that:
  - Programmatically overrides xterm's inline `touch-action` on `.xterm-screen` and `.xterm-viewport`
  - Registers a `touchmove` listener with `{ passive: false }` that calls `e.preventDefault()` to block iOS page scroll
  - Manually scrolls the terminal using `this.term.scrollLines()` based on touch delta, with a sub-line pixel accumulator for smooth scrolling
- **CSS**: Added `touch-action: none !important` on `.pane-terminal`, `.xterm-viewport`, and `.xterm-screen` in the mobile media query as a belt-and-suspenders measure.

**Files**: `terminal/public/style.css`, `terminal/public/js/terminal-pane.js`

## Bug 3: iOS Chrome Scrolls Document When Focusing Textarea

### Symptom

Tapping the input textarea to open the keyboard caused iOS Chrome to scroll the document downward, creating a large blank space below the input bar. The terminal content disappeared above the viewport.

### Root Cause

When iOS opens the virtual keyboard, it resizes the visual viewport and scrolls the focused element into view. Even with `position: fixed` on the layout, iOS Chrome still triggers a document scroll event. The `100dvh` height adjusts correctly, but the scroll offset is not reset.

### Fix

Added a `killScroll` function that aggressively resets scroll position to `(0, 0)` on multiple events:

```js
const killScroll = () => {
  window.scrollTo(0, 0)
  document.documentElement.scrollTop = 0
  document.body.scrollTop = 0
}

window.addEventListener('scroll', killScroll)
document.addEventListener('scroll', killScroll)

chatInput.addEventListener('focus', () => {
  setTimeout(killScroll, 50)
  setTimeout(killScroll, 150)
  setTimeout(killScroll, 300)
})

window.visualViewport.addEventListener('resize', () => {
  document.documentElement.style.setProperty('--vvh', `${window.visualViewport.height}px`)
  killScroll()
})
window.visualViewport.addEventListener('scroll', killScroll)
```

The staggered `setTimeout` calls on focus are necessary because iOS triggers the scroll at unpredictable times during the keyboard animation (which takes ~250ms).

**Files**: `terminal/public/js/app.js`

## Lessons Learned

1. **iOS treats `<html>` and `<body>` scroll independently.** Setting `overflow: hidden` on `<body>` alone does not prevent scrolling on iOS. Both elements need `position: fixed; overflow: hidden` for a truly locked viewport.

2. **Inline styles from libraries defeat CSS `!important`.** xterm.js sets `touch-action: none` as an inline style on `.xterm-screen` via JavaScript. CSS `!important` in a stylesheet cannot reliably override inline styles. The fix must be programmatic — set the style via JS after xterm renders, and handle touch events manually.

3. **`passive: false` is required to `preventDefault()` touch events.** Modern browsers default touch event listeners to `{ passive: true }` for performance. Calling `e.preventDefault()` in a passive listener is silently ignored. You must explicitly pass `{ passive: false }` to block the default scroll behavior.

4. **iOS keyboard focus scroll is a distinct problem from viewport resize.** Even with a fully locked layout (`position: fixed`, `overflow: hidden`, `100dvh`), iOS will still fire `scroll` events when a text input is focused and the keyboard opens. The only reliable fix is to listen for scroll events and force the scroll position back to zero.

5. **Programmatic `.focus()` on iOS has side effects.** Desktop browsers focus an input silently. iOS opens the virtual keyboard and scrolls to the element. Any `focus()` call in a mobile context should be intentional and expected by the user (i.e., they tapped something that should open the keyboard).

6. **Test on real iOS devices.** Desktop browser device emulation does not reproduce iOS scroll behavior. The virtual keyboard, overscroll bounce, and `visualViewport` behavior are all iOS-specific and cannot be simulated.

## Affected Files

| File                                  | Changes                                                                               |
| ------------------------------------- | ------------------------------------------------------------------------------------- |
| `terminal/public/js/app.js`           | `killScroll` listener, guarded `focus()` calls, `visualViewport` handler              |
| `terminal/public/js/terminal-pane.js` | `_initTouchScroll()` method with manual touch scroll handling                         |
| `terminal/public/style.css`           | `position: fixed` on html/body, `overscroll-behavior: none`, `touch-action` overrides |
