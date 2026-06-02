/**
 * Theme manager — dark (default) / light.
 *
 * Our fork design is dark-first (visionOS glass). The toggle
 * switches to a lighter surface variant when requested.
 *
 * Resolves the initial theme from:
 *   1. localStorage.nanocodeTheme  ("dark" | "light")
 *   2. window.matchMedia('(prefers-color-scheme: dark)') — OS preference
 *   3. dark (our default)
 *
 * Applies via `<html data-theme="light">`; CSS [data-theme="light"]
 * overrides surface tokens. Dark mode (default) needs no attribute.
 * Notifies listeners (e.g. xterm panes) via a custom
 * 'nanocode:theme' event on document.
 */

const STORAGE_KEY = 'nanocodeTheme'

function detectInitial() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored === 'dark' || stored === 'light') return stored
  } catch {}
  // Default to dark; only override if user explicitly prefers light.
  if (window.matchMedia && !window.matchMedia('(prefers-color-scheme: dark)').matches) return 'light'
  return 'dark'
}

let current = detectInitial()
applyTheme(current)

function applyTheme(theme) {
  current = theme
  // Set on <html> to match the pre-paint script in index.html.
  const root = document.documentElement
  if (theme === 'light') root.setAttribute('data-theme', 'light')
  else root.removeAttribute('data-theme')
}

export function getTheme() {
  return current
}

export function setTheme(theme, { persist = true } = {}) {
  if (theme !== 'dark' && theme !== 'light') return
  if (theme === current) return
  applyTheme(theme)
  if (persist) {
    try { localStorage.setItem(STORAGE_KEY, theme) } catch {}
  }
  // Broadcast for non-CSS consumers (xterm theme is set in JS, not CSS).
  document.dispatchEvent(new CustomEvent('nanocode:theme', { detail: { theme } }))
}

export function toggleTheme() {
  setTheme(current === 'dark' ? 'light' : 'dark')
}

/** Wire up the header toggle button. Idempotent. */
export function initThemeToggle() {
  const btn = document.getElementById('theme-toggle')
  if (!btn) return
  if (btn.dataset.themeWired === '1') return
  btn.dataset.themeWired = '1'
  btn.addEventListener('click', () => toggleTheme())

  // Follow OS preference if the user hasn't explicitly chosen.
  if (window.matchMedia) {
    try {
      const mq = window.matchMedia('(prefers-color-scheme: dark)')
      mq.addEventListener('change', (e) => {
        let stored = null
        try { stored = localStorage.getItem(STORAGE_KEY) } catch {}
        if (stored !== 'dark' && stored !== 'light') {
          setTheme(e.matches ? 'dark' : 'light', { persist: false })
        }
      })
    } catch {}
  }
}
