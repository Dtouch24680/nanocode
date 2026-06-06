function escapeSelectorValue(value) {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
    return CSS.escape(value)
  }
  return String(value).replace(/["\\]/g, '\\$&')
}

export function stampToolUseIdentity(article, toolId) {
  if (toolId) article.setAttribute('data-tool-id', toolId)
}

export function pairToolResult({
  scrollRoot,
  toolUseId,
  resultHtml,
  isError = false,
  attachCopyHandlers,
}) {
  if (!toolUseId) return false
  const toolBlock = scrollRoot.querySelector(`[data-tool-id="${escapeSelectorValue(toolUseId)}"]`)
  if (!toolBlock) return false

  toolBlock.classList.remove('cbr-tool-loading-state')
  const runningBadge = toolBlock.querySelector('.cbr-tool-running-badge')
  if (runningBadge) runningBadge.remove()

  const outputDiv = toolBlock.querySelector('.cbr-tool-output')
  if (!outputDiv) return false

  outputDiv.innerHTML = resultHtml
  if (isError) toolBlock.classList.add('cbr-tool-block--error')
  attachCopyHandlers(outputDiv)
  return true
}
