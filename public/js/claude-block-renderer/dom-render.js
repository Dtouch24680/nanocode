function makeBlock(extraClasses = '') {
  const article = document.createElement('article')
  article.className = `cbr-block ${extraClasses}`.trim()
  return article
}

function bindToolFoldCycle(article, { cycleToolFold, getToolFoldLevel }) {
  article.style.cursor = 'pointer'

  let touchHandled = false
  const onCycle = (e) => {
    const target = e.target
    if (target.closest('.cbr-copy-btn') || target.closest('a') || target.tagName === 'A') return
    cycleToolFold(article)
    e.stopPropagation()
  }

  const headerEl = article.querySelector('.cbr-tool-header')
  if (headerEl) {
    headerEl.addEventListener('touchstart', () => { touchHandled = false }, { passive: true })
    headerEl.addEventListener('touchmove', () => { touchHandled = true }, { passive: true })
    headerEl.addEventListener('touchend', (e) => {
      if (touchHandled) return
      touchHandled = true
      onCycle(e)
      e.preventDefault()
    }, { passive: false })
    headerEl.addEventListener('click', (e) => {
      if (touchHandled) { touchHandled = false; return }
      onCycle(e)
    })
  }

  article.addEventListener('touchstart', () => { touchHandled = false }, { passive: true })
  article.addEventListener('touchmove', () => { touchHandled = true }, { passive: true })
  article.addEventListener('touchend', (e) => {
    if (touchHandled) return
    const cur = article.getAttribute('data-fold') || getToolFoldLevel()
    if (cur !== 'line') return
    touchHandled = true
    onCycle(e)
    e.preventDefault()
  }, { passive: false })
  article.addEventListener('click', (e) => {
    if (touchHandled) { touchHandled = false; return }
    const cur = article.getAttribute('data-fold') || getToolFoldLevel()
    if (cur !== 'line') return
    onCycle(e)
  })
}

function bindStandaloneResultFoldCycle(article, cycleToolFold) {
  article.style.cursor = 'pointer'
  let touchHandled = false
  const onCycle = (e) => {
    if (e.target.closest('.cbr-copy-btn') || e.target.closest('a') || e.target.tagName === 'A') return
    cycleToolFold(article)
  }

  article.addEventListener('touchstart', () => { touchHandled = false }, { passive: true })
  article.addEventListener('touchmove', () => { touchHandled = true }, { passive: true })
  article.addEventListener('touchend', (e) => {
    if (touchHandled) return
    touchHandled = true
    onCycle(e)
    e.preventDefault()
  }, { passive: false })
  article.addEventListener('click', (e) => {
    if (touchHandled) { touchHandled = false; return }
    onCycle(e)
  })
}

export function createSystemBlock(msg, { escHtml }) {
  const article = makeBlock('cbr-block-system')
  article.innerHTML = `<p class="cbr-system">${escHtml(msg)}</p>`
  return article
}

export function createUserBlock(text, { escHtml, attachPathAndUrlHandlers }) {
  const article = makeBlock('cbr-block-prompt cbr-user-prompt')
  article.innerHTML = `<p class="cbr-prompt-text">&#10095; ${escHtml(text)}</p>`
  attachPathAndUrlHandlers(article)
  return article
}

export function createThinkingBlock(text, { escHtml }) {
  const charCount = text.length
  const article = makeBlock('cbr-block-thinking')
  article.dataset.collapsed = '1'
  article.innerHTML =
    `<div class="cbr-thinking-header" role="button" tabindex="0" aria-expanded="false">` +
    `<svg class="cbr-thinking-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>` +
    `<span class="cbr-thinking-label">Thinking</span>` +
    `<span class="cbr-thinking-count">${charCount.toLocaleString()} chars</span>` +
    `</div>` +
    `<div class="cbr-thinking-body" hidden><pre class="cbr-pre cbr-thinking-pre">${escHtml(text)}</pre></div>`

  const header = article.querySelector('.cbr-thinking-header')
  const body = article.querySelector('.cbr-thinking-body')
  const chevron = article.querySelector('.cbr-thinking-chevron')

  const toggle = () => {
    const collapsed = article.dataset.collapsed === '1'
    if (collapsed) {
      article.dataset.collapsed = '0'
      body.hidden = false
      header.setAttribute('aria-expanded', 'true')
      chevron.style.transform = 'rotate(180deg)'
    } else {
      article.dataset.collapsed = '1'
      body.hidden = true
      header.setAttribute('aria-expanded', 'false')
      chevron.style.transform = ''
    }
  }

  header.addEventListener('click', toggle)
  header.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      toggle()
    }
  })

  return article
}

export function createTextBlock(text, { live = false, renderMarkdown, escHtml, attachCopyHandlers, attachPathAndUrlHandlers }) {
  const article = makeBlock('cbr-block-text' + (live ? ' cbr-live' : ''))
  let html
  try {
    html = renderMarkdown(text)
  } catch {
    html = `<p>${escHtml(text)}</p>`
  }
  article.innerHTML = `<div class="cbr-text">${html}</div>`
  attachCopyHandlers(article)
  attachPathAndUrlHandlers(article)
  return article
}

export function createToolUseBlock({
  part,
  inputHtml,
  toolIcon,
  isLoading,
  isSubagentTool,
  isSubagentPrompt,
  isSubagentActivity,
  activityVisible,
  getSubagentPromptVisible,
  applyToolFold,
  getToolFoldLevel,
  cycleToolFold,
  attachCopyHandlers,
  escHtml,
}) {
  const toolName = escHtml(part.name || 'tool')
  const extraClass = isSubagentPrompt ? ' cbr-block-subagent-prompt' : ''
  const activityClass = isSubagentActivity ? ' cbr-block-subagent-activity' : ''
  const loadingClass = isLoading ? ' cbr-tool-loading-state' : ''
  const article = makeBlock('cbr-block-tool' + extraClass + activityClass + loadingClass)

  article.innerHTML =
    `<div class="cbr-tool-card">` +
    `<div class="cbr-tool-header">` +
    (toolIcon ? `<span class="cbr-tool-icon-wrap">${toolIcon}</span>` : '') +
    `<span class="cbr-tool-name">${toolName}</span>` +
    (isSubagentTool ? `<span class="cbr-subagent-badge">subagent</span>` : '') +
    (isLoading ? `<span class="cbr-tool-running-badge">running…</span>` : '') +
    `<button class="cbr-tool-fold-btn" type="button" title="Toggle fold" aria-label="Toggle fold">` +
    `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>` +
    `</button>` +
    `</div>` +
    `<div class="cbr-tool-body">${inputHtml}</div>` +
    `<div class="cbr-tool-output"></div>` +
    `</div>`

  if (isSubagentPrompt && !getSubagentPromptVisible()) {
    article.style.display = 'none'
  }
  if (isSubagentActivity && activityVisible === false) {
    article.style.display = 'none'
  }

  bindToolFoldCycle(article, { cycleToolFold, getToolFoldLevel })

  if (isSubagentPrompt) {
    article.setAttribute('data-fold', 'full')
  } else {
    applyToolFold(article)
  }
  attachCopyHandlers(article)
  return article
}

export function buildToolResultHtml(part, { escHtml }) {
  const content = part.content
  const isError = part.is_error === true

  let text = ''
  let hasImage = false
  const imageItems = []
  if (typeof content === 'string') {
    text = content
  } else if (Array.isArray(content)) {
    const textParts = content.filter((c) => c.type === 'text').map((c) => c.text)
    text = textParts.join('\n')
    for (const c of content) {
      if (c.type === 'image') {
        hasImage = true
        imageItems.push(c)
      }
    }
  }

  const displayText = text.trim()
    ? text
    : hasImage
      ? ''
      : content == null
        ? '(no result)'
        : '(empty result)'

  const truncated = displayText.length > 2000
  const displaySlice = truncated ? displayText.slice(0, 2000) + '\n…' : displayText
  const errorClass = isError ? ' cbr-tool-result--error' : ''

  let imageHtml = ''
  for (const img of imageItems) {
    const src = img.source
    if (src && src.type === 'base64' && src.media_type && src.data) {
      imageHtml += `<img class="cbr-inline-img" src="data:${escHtml(src.media_type)};base64,${src.data}" alt="tool image result" loading="lazy">`
    } else if (src && src.type === 'url' && src.url) {
      imageHtml += `<img class="cbr-inline-img" src="${escHtml(src.url)}" alt="tool image result" loading="lazy">`
    }
  }

  const resultHtml =
    `<div class="cbr-tool-result${errorClass}">` +
    (isError ? `<div class="cbr-tool-result-error-label">tool error</div>` : '') +
    (displaySlice ? `<pre class="cbr-pre cbr-tool-result-pre">${escHtml(displaySlice)}</pre>` : '') +
    (imageHtml ? `<div class="cbr-inline-img-wrap">${imageHtml}</div>` : '') +
    `</div>`

  return { resultHtml, isError }
}

export function createStandaloneToolResultBlock({
  resultHtml,
  isSubagentActivity,
  activityVisible,
  applyToolFold,
  cycleToolFold,
}) {
  const extraClass = isSubagentActivity ? ' cbr-block-subagent-activity' : ''
  const article = makeBlock('cbr-block-tool-result' + extraClass)
  if (isSubagentActivity && activityVisible === false) {
    article.style.display = 'none'
  }
  article.innerHTML = resultHtml
  applyToolFold(article)
  bindStandaloneResultFoldCycle(article, cycleToolFold)
  return article
}
