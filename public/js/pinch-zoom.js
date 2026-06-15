/**
 * pinch-zoom.js — two-finger pinch gesture → discrete zoom steps.
 *
 * attachPinchZoom(el, onStep) listens for two-finger touch gestures on `el`.
 * As the distance between the two fingers grows/shrinks past a threshold,
 * `onStep(+1)` (zoom in) or `onStep(-1)` (zoom out) fires and the baseline
 * resets — so a slow continuous pinch yields a steady stream of steps.
 *
 * The caller decides what a "step" means (xterm font size, CSS zoom, …),
 * keeping this module agnostic to the content being zoomed.
 */

// Fractional distance change that triggers one zoom step. ~12% per step gives
// responsive-but-not-twitchy zooming.
const STEP_RATIO = 0.12

/**
 * @param {HTMLElement} el
 * @param {(delta: 1 | -1) => void} onStep
 * @returns {() => void} detach function
 */
export function attachPinchZoom(el, onStep) {
  let baseDist = 0
  let pinching = false

  const dist = (touches) => {
    const dx = touches[0].clientX - touches[1].clientX
    const dy = touches[0].clientY - touches[1].clientY
    return Math.hypot(dx, dy)
  }

  const onTouchStart = (e) => {
    if (e.touches.length !== 2) return
    pinching = true
    baseDist = dist(e.touches)
  }

  // Non-passive: we preventDefault to stop the browser's own page-zoom/scroll.
  const onTouchMove = (e) => {
    if (!pinching || e.touches.length !== 2) return
    e.preventDefault()
    const d = dist(e.touches)
    if (baseDist <= 0) {
      baseDist = d
      return
    }
    const ratio = d / baseDist
    if (ratio >= 1 + STEP_RATIO) {
      onStep(1)
      baseDist = d
    } else if (ratio <= 1 - STEP_RATIO) {
      onStep(-1)
      baseDist = d
    }
  }

  const onTouchEnd = (e) => {
    if (e.touches.length < 2) {
      pinching = false
      baseDist = 0
    }
  }

  el.addEventListener('touchstart', onTouchStart, { passive: true })
  el.addEventListener('touchmove', onTouchMove, { passive: false })
  el.addEventListener('touchend', onTouchEnd, { passive: true })
  el.addEventListener('touchcancel', onTouchEnd, { passive: true })

  return () => {
    el.removeEventListener('touchstart', onTouchStart)
    el.removeEventListener('touchmove', onTouchMove)
    el.removeEventListener('touchend', onTouchEnd)
    el.removeEventListener('touchcancel', onTouchEnd)
  }
}

/**
 * Apply a CSS-`zoom` step to an element, clamped to [0.5, 2.5]. Used for
 * HTML content panes (block-renderer chat, Explorer preview) where reflow is
 * wanted and crisp text comes for free (unlike transform: scale).
 * @param {HTMLElement} el
 * @param {1 | -1} delta
 */
export function stepCssZoom(el, delta) {
  if (!el) return
  const cur = parseFloat(el.style.zoom) || 1
  const next = Math.max(0.5, Math.min(2.5, cur + delta * 0.1))
  el.style.zoom = String(next)
}
