function makeBlock(extraClasses = '') {
  const article = document.createElement('article')
  article.className = `cbr-block ${extraClasses}`.trim()
  return article
}

/**
 * Build a one-line command/path subhint string for a tool_use block.
 * Returns an escaped HTML string, or '' if nothing useful to show.
 * Each tool type extracts the most informative field.
 */
function buildToolSubhint(part, escHtml) {
  if (!part || !part.name) return ''
  const inp = part.input || {}
  const name = part.name

  let raw = ''

  if (name === 'Bash') {
    raw = (typeof inp.command === 'string') ? inp.command.slice(0, 120) : ''
  } else if (name === 'Edit' || name === 'Write' || name === 'MultiEdit') {
    const fp = inp.file_path || inp.path || ''
    if (fp) {
      // Show relative-like path: strip /storage/home/<user>/ prefix for brevity
      raw = fp.replace(/^\/storage\/home\/[^/]+\//, '~/')
                .replace(/^\/home\/[^/]+\//, '~/')
    }
  } else if (name === 'Read') {
    const fp = inp.file_path || inp.path || ''
    if (fp) {
      let r = fp.replace(/^\/storage\/home\/[^/]+\//, '~/')
                 .replace(/^\/home\/[^/]+\//, '~/')
      if (inp.offset != null || inp.limit != null) {
        const parts = []
        if (inp.offset != null) parts.push(`L${inp.offset}`)
        if (inp.limit != null) parts.push(`+${inp.limit}`)
        r += `:${parts.join('-')}`
      }
      raw = r
    }
  } else if (name === 'Glob') {
    raw = inp.pattern || ''
    if (inp.path) raw += ` in ${inp.path}`
    raw = raw.slice(0, 100)
  } else if (name === 'Grep') {
    raw = inp.pattern || ''
    if (inp.path) raw += ` in ${inp.path}`
    raw = raw.slice(0, 100)
  } else if (name === 'WebFetch') {
    raw = (inp.url || '').slice(0, 100)
  } else if (name === 'WebSearch') {
    raw = (inp.query || '').slice(0, 100)
  } else if (name === 'Task' || name === 'Agent') {
    raw = (inp.description || inp.prompt || '').slice(0, 100)
  } else if (name === 'TodoWrite') {
    const todos = Array.isArray(inp.todos) ? inp.todos : []
    const count = todos.length
    const first = todos[0]
    const subject = first ? (first.content || first.title || first.subject || '') : ''
    if (count > 0) {
      raw = `${count} task${count !== 1 ? 's' : ''}${subject ? ': ' + subject.slice(0, 60) : ''}`
    }
  } else if (name === 'Skill') {
    const skillName = inp.skill || inp.name || ''
    const args = inp.args || ''
    raw = skillName + (args ? ` ${args}` : '')
    raw = raw.slice(0, 100)
  } else if (name === 'Monitor') {
    raw = (inp.description || '').slice(0, 100)
  } else if (name === 'TaskCreate' || name === 'TaskUpdate') {
    raw = (inp.subject || inp.title || inp.description || '').slice(0, 80)
  } else {
    // Generic fallback: description field or first string param
    if (typeof inp.description === 'string') {
      raw = inp.description.slice(0, 100)
    } else {
      // First string value in the input object
      for (const v of Object.values(inp)) {
        if (typeof v === 'string' && v.trim()) {
          raw = v.slice(0, 100)
          break
        }
      }
    }
  }

  if (!raw.trim()) return ''
  return escHtml(raw)
}

function bindToolFoldCycle(article, { cycleToolFold, getToolFoldLevel }) {
  article.style.cursor = 'pointer'

  let touchHandled = false
  const onCycle = (e) => {
    const target = e.target
    if (target.closest('.cbr-copy-btn') || target.closest('a') || target.tagName === 'A') return
    // Prevent browser default (stops mobile keyboard from popping up on touch)
    // and stop propagation so any parent click-to-focus handlers don't run.
    e.preventDefault()
    e.stopPropagation()
    cycleToolFold(article)
    // On mobile the touch may have shifted focus to this element or chat-input;
    // blur whatever is focused so the soft keyboard stays hidden.
    if (document.activeElement && document.activeElement !== document.body) {
      document.activeElement.blur()
    }
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
    touchHandled = true
    onCycle(e)
    e.preventDefault()
  }, { passive: false })
  article.addEventListener('click', (e) => {
    if (touchHandled) { touchHandled = false; return }
    onCycle(e)
  })
}

function bindStandaloneResultFoldCycle(article, cycleToolFold) {
  article.style.cursor = 'pointer'
  let touchHandled = false
  const onCycle = (e) => {
    if (e.target.closest('.cbr-copy-btn') || e.target.closest('a') || e.target.tagName === 'A') return
    e.preventDefault()
    e.stopPropagation()
    cycleToolFold(article)
    if (document.activeElement && document.activeElement !== document.body) {
      document.activeElement.blur()
    }
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

  // Build subhint: always-visible one-line command/path summary.
  // Two copies:
  //   1. Inside .cbr-tool-card (for full/header mode — below header row)
  //   2. Outside .cbr-tool-card (for line mode — floats on 4px strip, hidden in full/header)
  const subhintText = buildToolSubhint(part, escHtml)
  // inner: shown in full/header mode (inside card, so display:none in line mode is fine)
  const subhintInner = subhintText
    ? `<div class="cbr-tool-subhint cbr-tool-subhint--inner" aria-hidden="true">${subhintText}</div>`
    : ''
  // outer: shown in line mode only (absolute-positioned on strip)
  const subhintOuter = subhintText
    ? `<div class="cbr-tool-subhint cbr-tool-subhint--line" aria-hidden="true">${subhintText}</div>`
    : ''

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
    subhintInner +
    `<div class="cbr-tool-body">${inputHtml}</div>` +
    `<div class="cbr-tool-output"></div>` +
    `</div>` +
    subhintOuter

  if (isSubagentPrompt && !getSubagentPromptVisible()) {
    article.style.display = 'none'
  }
  if (isSubagentActivity && activityVisible === false) {
    article.style.display = 'none'
  }

  bindToolFoldCycle(article, { cycleToolFold, getToolFoldLevel })

  // All tool blocks (including subagent-prompt) follow the global fold setting.
  applyToolFold(article)
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

/**
 * Create a collapsed "skill load" block for user-turn messages that begin with
 * "Base directory for this skill: <path>".
 *
 * The block shows a summary line (skill name + char count) and hides the full
 * content behind a click-to-expand chevron — same interaction pattern as the
 * Thinking block.
 *
 * @param {string} text  - Full raw text of the skill load message.
 * @param {{ escHtml: Function }} deps
 */
export function createSkillLoadBlock(text, { escHtml }) {
  // Parse skill name from first line: "Base directory for this skill: /path/to/skills/<name>"
  const firstLine = text.split('\n')[0] || ''
  const pathMatch = firstLine.match(/Base directory for this skill:\s*(.+)/)
  let skillName = ''
  if (pathMatch) {
    const parts = pathMatch[1].trim().split('/')
    skillName = parts[parts.length - 1] || ''
  }
  const charCount = text.length

  const article = makeBlock('cbr-block-skill-load')
  article.dataset.collapsed = '1'

  article.innerHTML =
    `<div class="cbr-skill-load-header" role="button" tabindex="0" aria-expanded="false">` +
    `<svg class="cbr-skill-load-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>` +
    `<span class="cbr-skill-load-icon">&#128218;</span>` +
    `<span class="cbr-skill-load-label">Loaded skill: ${escHtml(skillName || 'unknown')}</span>` +
    `<span class="cbr-skill-load-count">${charCount.toLocaleString()} chars</span>` +
    `</div>` +
    `<div class="cbr-skill-load-body" hidden><pre class="cbr-pre cbr-skill-load-pre">${escHtml(text)}</pre></div>`

  const header = article.querySelector('.cbr-skill-load-header')
  const body = article.querySelector('.cbr-skill-load-body')
  const chevron = article.querySelector('.cbr-skill-load-chevron')

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
