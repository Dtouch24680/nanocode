/**
 * Tool-block fold state — shared between ClaudeBlockRenderer and
 * OpenCodeBlockRenderer.
 *
 * Three levels (persisted in localStorage):
 *   'full'    — show tool name + full input/output content
 *   'header'  — show only the tool name header (block state)
 *   'line'    — collapse to a single thin line (default)
 *
 * Cycle order: full → line → full → … (header is reachable via settings only)
 */

export const TOOL_FOLD_KEY = 'cbr_tool_fold'
export const TOOL_FOLD_LEVELS = ['full', 'header', 'line']

// 2-state click cycle: full ↔ line (header accessible via settings panel only)
export const TOOL_FOLD_CYCLE = { full: 'line', header: 'full', line: 'full' }

export function getToolFoldLevel() {
  const v = localStorage.getItem(TOOL_FOLD_KEY)
  return TOOL_FOLD_LEVELS.includes(v) ? v : 'line'
}

export function setToolFoldLevel(level) {
  if (!TOOL_FOLD_LEVELS.includes(level)) return
  localStorage.setItem(TOOL_FOLD_KEY, level)
  document.querySelectorAll('.cbr-block-tool, .cbr-block-tool-result').forEach((el) => {
    applyToolFold(el, level)
  })
  document.dispatchEvent(new CustomEvent('cbr:tool-fold-changed', { detail: { level } }))
}

export function applyToolFold(el, level) {
  el.setAttribute('data-fold', level || getToolFoldLevel())
}

export function cycleToolFold(article) {
  const cur = article.getAttribute('data-fold') || getToolFoldLevel()
  const next = TOOL_FOLD_CYCLE[cur] || 'full'
  article.setAttribute('data-fold', next)
}
