/**
 * File Explorer — vanilla JS port of akari-webapp's FileExplorer.tsx.
 *
 * Behavior:
 *   - Hierarchical tree (expand/collapse dirs)
 *   - Click a file → preview (image / markdown / code / plaintext)
 *   - Pencil → inline textarea edit → Save (PUT /files/content)
 *   - Download button → /files/raw?disposition=attachment
 *   - Drag/drop onto the panel → POST /files/upload to current dir
 *   - 10s polling refresh for root + expanded dirs
 *   - Remote-SSH projects: render an "unsupported" placeholder instead
 *
 * Globals expected on window (loaded via <script> tags in index.html):
 *   - marked     (UMD)
 *   - DOMPurify  (UMD)
 *   - hljs       (UMD)
 */

const POLL_INTERVAL_MS = 10_000
const POLL_DIR_CAP = 50
const STORAGE_PREFIX = 'explorer:'

function loadExplorerState(projectId) {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + projectId)
    if (!raw) return null
    const obj = JSON.parse(raw)
    return {
      selectedPath: typeof obj.selectedPath === 'string' ? obj.selectedPath : null,
      htmlViewMode: obj.htmlViewMode === 'raw' ? 'raw' : 'preview',
      expanded: Array.isArray(obj.expanded) ? obj.expanded.filter((p) => typeof p === 'string') : [],
    }
  } catch {
    return null
  }
}

function saveExplorerState(projectId, state) {
  try {
    localStorage.setItem(STORAGE_PREFIX + projectId, JSON.stringify({
      selectedPath: state.selectedPath || null,
      htmlViewMode: state.htmlViewMode || 'preview',
      expanded: Array.from(state.expanded || []),
    }))
  } catch {}
}

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'bmp'])
const MARKDOWN_EXTS = new Set(['md', 'markdown', 'mdx'])
const HTML_EXTS = new Set(['html', 'htm'])
const GLB_EXTS = new Set(['glb'])

// Map common code file extensions to highlight.js language ids
const HLJS_LANG_MAP = {
  ts: 'typescript', tsx: 'typescript',
  js: 'javascript', mjs: 'javascript', jsx: 'javascript', cjs: 'javascript',
  json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'ini',
  py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java',
  c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', hpp: 'cpp', cxx: 'cpp',
  cs: 'csharp', php: 'php', swift: 'swift', kt: 'kotlin', scala: 'scala',
  sh: 'bash', bash: 'bash', zsh: 'bash', fish: 'bash',
  html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml',
  css: 'css', scss: 'scss', less: 'less',
  sql: 'sql',
  md: 'markdown', markdown: 'markdown',
  dockerfile: 'dockerfile',
  makefile: 'makefile',
}

function extOf(path) {
  const name = path.split('/').pop() || ''
  if (name.toLowerCase() === 'dockerfile') return 'dockerfile'
  if (name.toLowerCase() === 'makefile') return 'makefile'
  const i = name.lastIndexOf('.')
  return i >= 0 ? name.slice(i + 1).toLowerCase() : ''
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function dirOf(p) {
  if (!p) return ''
  const i = p.lastIndexOf('/')
  return i < 0 ? '' : p.slice(0, i)
}

/**
 * Create an Explorer attached to a container.
 * @returns {{ destroy(): void, switchProject(projectId: string): void }}
 */
export function createExplorer(container, projectId) {
  let project = projectId

  // State
  let entriesByDir = new Map() // dirPath ('' is root) → entries[]
  let dirHashes = new Map()    // dirPath → last-seen hash (for poll change detection)
  let expanded = new Set()      // dir paths
  let remote = false
  let selectedPath = null
  let selectedSize = 0
  let fileContent = null
  let fileError = null
  let editing = false
  let editContent = ''
  let saving = false
  let uploading = false
  let dragCounter = 0
  let htmlViewMode = 'preview' // 'preview' | 'raw' — only used for HTML files
  let glbMode = 'material'     // 'material' | 'color' | 'clay' | 'wireframe'
  let glbViewer = null         // active GlbViewer instance (must dispose on teardown)
  let glbViewerToken = 0       // increments per load so stale async loads can no-op

  let pollTimer = null
  let cancelled = false

  function disposeGlbViewer() {
    if (glbViewer) {
      try { glbViewer.dispose() } catch {}
      glbViewer = null
    }
  }

  // DOM
  container.innerHTML = ''
  container.classList.add('explorer')
  const dropOverlay = document.createElement('div')
  dropOverlay.className = 'explorer-drop-overlay'
  dropOverlay.textContent = 'Drop to upload'
  container.appendChild(dropOverlay)

  const headerEl = document.createElement('div')
  headerEl.className = 'explorer-header'
  container.appendChild(headerEl)

  const bodyEl = document.createElement('div')
  bodyEl.className = 'explorer-body'
  container.appendChild(bodyEl)

  const treeEl = document.createElement('div')
  treeEl.className = 'explorer-tree'
  bodyEl.appendChild(treeEl)

  const splitEl = document.createElement('div')
  splitEl.className = 'explorer-split'
  splitEl.setAttribute('role', 'separator')
  splitEl.setAttribute('aria-orientation', 'vertical')
  splitEl.title = 'Drag to resize'
  bodyEl.appendChild(splitEl)

  const previewEl = document.createElement('div')
  previewEl.className = 'explorer-preview'
  bodyEl.appendChild(previewEl)

  // Apply persisted tree width (global preference).
  const SPLIT_KEY = 'explorerTreeWidthPct'
  function applySplitPct(pct) {
    const clamped = Math.min(75, Math.max(15, pct))
    bodyEl.style.setProperty('--explorer-split', clamped + '%')
  }
  try {
    const saved = parseFloat(localStorage.getItem(SPLIT_KEY))
    if (Number.isFinite(saved)) applySplitPct(saved)
  } catch {}

  // Drag handler — sets --explorer-split on bodyEl as a percentage.
  splitEl.addEventListener('mousedown', (e) => {
    e.preventDefault()
    splitEl.classList.add('active')
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'

    const onMove = (ev) => {
      const rect = bodyEl.getBoundingClientRect()
      const x = ev.clientX - rect.left
      const pct = (x / rect.width) * 100
      applySplitPct(pct)
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      splitEl.classList.remove('active')
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      // Persist the final value
      const pct = parseFloat(bodyEl.style.getPropertyValue('--explorer-split'))
      if (Number.isFinite(pct)) {
        try { localStorage.setItem(SPLIT_KEY, String(pct)) } catch {}
      }
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  })

  // Double-click on divider → reset to default
  splitEl.addEventListener('dblclick', () => {
    bodyEl.style.removeProperty('--explorer-split')
    try { localStorage.removeItem(SPLIT_KEY) } catch {}
  })

  // --- API ---

  async function apiList(dirPath) {
    const url = `/api/projects/${project}/files?path=${encodeURIComponent(dirPath)}`
    const res = await fetch(url)
    if (!res.ok) throw new Error(`list failed: ${res.status}`)
    return res.json()
  }

  async function apiContent(filePath) {
    const url = `/api/projects/${project}/files/content?path=${encodeURIComponent(filePath)}`
    const res = await fetch(url)
    if (!res.ok) throw new Error(`content failed: ${res.status}`)
    return res.json()
  }

  async function apiSave(filePath, content) {
    const res = await fetch(`/api/projects/${project}/files/content`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: filePath, content }),
    })
    if (!res.ok) throw new Error(`save failed: ${res.status}`)
    return res.json()
  }

  async function apiUpload(file, destPath) {
    const form = new FormData()
    form.append('file', file)
    const url = `/api/projects/${project}/files/upload?dest_path=${encodeURIComponent(destPath)}`
    const res = await fetch(url, { method: 'POST', body: form })
    if (!res.ok) throw new Error(`upload failed: ${res.status}`)
    return res.json()
  }

  async function apiMkdir(path) {
    const res = await fetch(`/api/projects/${project}/files/mkdir`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    })
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      throw new Error(body.error || `mkdir failed: ${res.status}`)
    }
    return res.json()
  }

  async function apiRename(from, to) {
    const res = await fetch(`/api/projects/${project}/files/rename`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to }),
    })
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      throw new Error(body.error || `rename failed: ${res.status}`)
    }
    return res.json()
  }

  /** Create an empty file via PUT /files/content. */
  async function apiCreateFile(path) {
    return apiSave(path, '')
  }

  function rawUrl(filePath, inline = true) {
    const q = inline ? '&inline=1' : ''
    return `/api/projects/${project}/files/raw?path=${encodeURIComponent(filePath)}${q}`
  }

  /** Path-mirrored serve URL. Used by HTML previews so sibling resources resolve. */
  function serveUrl(filePath) {
    // encodeURI (not encodeURIComponent) preserves / separators so the URL
    // path mirrors the filesystem path.
    return `/api/projects/${project}/serve/${encodeURI(filePath)}`
  }

  // --- Data ---

  /** Stable hash of an entries listing for change detection. */
  function entriesHash(entries) {
    let h = 5381
    for (const e of entries) {
      const s = `${e.path}|${e.type}|${e.size}`
      for (let i = 0; i < s.length; i++) {
        h = ((h * 33) ^ s.charCodeAt(i)) | 0
      }
    }
    return h.toString(36)
  }

  /**
   * Load a directory listing.
   * @param {string} dirPath
   * @param {{ forceRender?: boolean }} [opts] - forceRender bypasses hash skip
   *   (used on initial load + after explicit user actions; polling leaves it false).
   */
  async function loadDir(dirPath, opts = {}) {
    try {
      const data = await apiList(dirPath)
      if (cancelled || project !== projectId) return
      if (data.remote) {
        remote = true
        renderRemote()
        return
      }
      const newEntries = data.entries || []
      const newHash = entriesHash(newEntries)
      const oldHash = dirHashes.get(dirPath)
      if (!opts.forceRender && oldHash === newHash) {
        // No structural change — skip render entirely so any open iframe /
        // edit textarea / scroll position is preserved.
        return
      }
      dirHashes.set(dirPath, newHash)
      entriesByDir.set(dirPath, newEntries)
      // Tree-only render — never touch the preview pane from polling.
      renderTree()
    } catch (err) {
      console.error('Explorer load failed', err)
    }
  }

  async function expandDir(dirPath) {
    expanded.add(dirPath)
    if (!entriesByDir.has(dirPath)) await loadDir(dirPath, { forceRender: true })
    else renderTree()
    persist()
  }

  function collapseDir(dirPath) {
    expanded.delete(dirPath)
    renderTree()
    persist()
  }

  async function selectFile(filePath, size, opts = {}) {
    // If the same file is clicked again with no special intent, no-op so the
    // iframe (or other live preview content) doesn't get torn down.
    if (selectedPath === filePath && !opts.force) {
      // Still ensure preview reflects current state if editing was active.
      return
    }
    selectedPath = filePath
    selectedSize = size
    fileContent = null
    fileError = null
    editing = false
    if (!opts.preserveHtmlViewMode) htmlViewMode = 'preview'
    renderTree()      // tree-selection highlight changed
    renderPreview()   // preview shows loading
    persist()

    const ext = extOf(filePath)
    if (IMAGE_EXTS.has(ext)) {
      renderPreview() // image renders without content fetch
      return
    }
    if (GLB_EXTS.has(ext)) {
      renderPreview() // GLB renders via three.js using the raw URL
      return
    }

    try {
      const data = await apiContent(filePath)
      if (cancelled || selectedPath !== filePath) return
      if (data.error) {
        fileError = data.error
        fileContent = null
      } else {
        fileContent = data.content || ''
        selectedSize = data.size ?? selectedSize
      }
      renderPreview()
    } catch (err) {
      fileError = err.message
      renderPreview()
    }
  }

  async function refreshAll() {
    if (remote) return
    const toFetch = ['', ...Array.from(expanded)].slice(0, POLL_DIR_CAP)
    await Promise.all(toFetch.map((d) => loadDir(d)))
  }

  function startPolling() {
    if (pollTimer) return
    pollTimer = setInterval(() => {
      if (cancelled) return
      refreshAll().catch(() => {})
    }, POLL_INTERVAL_MS)
  }

  // --- Render ---

  function renderRemote() {
    headerEl.innerHTML = ''
    bodyEl.innerHTML = ''
    const empty = document.createElement('div')
    empty.className = 'explorer-remote-empty'
    empty.innerHTML = '<strong>Remote browsing unsupported</strong><br><small>Use the terminal tabs to explore this project.</small>'
    bodyEl.appendChild(empty)
  }

  function render() {
    if (remote) return renderRemote()
    renderHeader()
    renderTree()
    renderPreview()
  }

  /** Resolve the current "context dir" — where new items are created. */
  function currentDir() {
    if (!selectedPath) return ''
    // selectedPath always names a file in the current flow; create alongside it.
    return dirOf(selectedPath)
  }

  function renderHeader() {
    headerEl.innerHTML = ''

    const title = document.createElement('div')
    title.className = 'explorer-title'
    title.textContent = 'Explorer'
    headerEl.appendChild(title)

    const actions = document.createElement('div')
    actions.className = 'explorer-actions'

    const newFileBtn = document.createElement('button')
    newFileBtn.type = 'button'
    newFileBtn.className = 'explorer-icon-btn'
    newFileBtn.title = 'New file in current dir'
    newFileBtn.innerHTML = svgIcon('file-plus')
    newFileBtn.addEventListener('click', () => promptNewFile())
    actions.appendChild(newFileBtn)

    const newFolderBtn = document.createElement('button')
    newFolderBtn.type = 'button'
    newFolderBtn.className = 'explorer-icon-btn'
    newFolderBtn.title = 'New folder in current dir'
    newFolderBtn.innerHTML = svgIcon('folder-plus')
    newFolderBtn.addEventListener('click', () => promptNewFolder())
    actions.appendChild(newFolderBtn)

    const uploadBtn = document.createElement('label')
    uploadBtn.className = 'explorer-icon-btn'
    uploadBtn.title = 'Upload to current dir'
    uploadBtn.innerHTML = svgIcon('upload')
    const fileInput = document.createElement('input')
    fileInput.type = 'file'
    fileInput.hidden = true
    fileInput.addEventListener('change', async () => {
      if (!fileInput.files?.length) return
      await handleUpload(Array.from(fileInput.files), currentDir())
      fileInput.value = ''
    })
    uploadBtn.appendChild(fileInput)
    actions.appendChild(uploadBtn)

    const refreshBtn = document.createElement('button')
    refreshBtn.type = 'button'
    refreshBtn.className = 'explorer-icon-btn'
    refreshBtn.title = 'Refresh'
    refreshBtn.innerHTML = svgIcon('refresh')
    refreshBtn.addEventListener('click', () => refreshAll())
    actions.appendChild(refreshBtn)

    headerEl.appendChild(actions)
  }

  // --- Create new file / folder ---

  async function promptNewFile() {
    const dir = currentDir()
    const name = window.prompt(`New file in "${dir || '/'}"`, '')
    if (!name) return
    const trimmed = name.trim()
    if (!trimmed || trimmed.includes('/')) {
      alert('Filename cannot be empty or contain "/".')
      return
    }
    const fullPath = dir ? `${dir}/${trimmed}` : trimmed
    try {
      await apiCreateFile(fullPath)
      if (dir) expanded.add(dir)
      await refreshAll()
      selectFile(fullPath, 0)
    } catch (err) {
      alert('Create failed: ' + err.message)
    }
  }

  async function promptNewFolder() {
    const dir = currentDir()
    const name = window.prompt(`New folder in "${dir || '/'}"`, '')
    if (!name) return
    const trimmed = name.trim()
    if (!trimmed || trimmed.includes('/')) {
      alert('Folder name cannot be empty or contain "/".')
      return
    }
    const fullPath = dir ? `${dir}/${trimmed}` : trimmed
    try {
      await apiMkdir(fullPath)
      if (dir) expanded.add(dir)
      expanded.add(fullPath)
      await refreshAll()
    } catch (err) {
      alert('Create failed: ' + err.message)
    }
  }

  function renderTree() {
    treeEl.innerHTML = ''
    const root = entriesByDir.get('') || []
    if (!root.length) {
      const empty = document.createElement('div')
      empty.className = 'explorer-tree-empty'
      empty.textContent = 'Loading…'
      treeEl.appendChild(empty)
      return
    }
    for (const entry of root) renderEntry(entry, 0, treeEl)
  }

  function renderEntry(entry, depth, parent) {
    const row = document.createElement('button')
    row.type = 'button'
    const isHidden = entry.name.startsWith('.')
    row.className =
      'tree-row' +
      (entry.path === selectedPath ? ' selected' : '') +
      (isHidden ? ' hidden-entry' : '')
    row.style.paddingLeft = `${depth * 12 + 8}px`
    row.dataset.path = entry.path
    row.dataset.type = entry.type

    if (entry.type === 'dir') {
      const isOpen = expanded.has(entry.path)
      const chev = document.createElement('span')
      chev.className = 'tree-chev'
      chev.innerHTML = isOpen ? svgIcon('chev-down') : svgIcon('chev-right')
      row.appendChild(chev)
      const icon = document.createElement('span')
      icon.className = 'tree-icon'
      icon.innerHTML = svgIcon(isOpen ? 'folder-open' : 'folder')
      row.appendChild(icon)
    } else {
      const spacer = document.createElement('span')
      spacer.className = 'tree-chev'
      row.appendChild(spacer)
      const icon = document.createElement('span')
      icon.className = 'tree-icon'
      icon.innerHTML = svgIcon('file')
      row.appendChild(icon)
    }

    const label = document.createElement('span')
    label.className = 'tree-label'
    label.textContent = entry.name
    row.appendChild(label)

    row.addEventListener('click', () => {
      if (entry.type === 'dir') {
        if (expanded.has(entry.path)) collapseDir(entry.path)
        else expandDir(entry.path)
      } else {
        selectFile(entry.path, entry.size)
      }
    })

    parent.appendChild(row)

    if (entry.type === 'dir' && expanded.has(entry.path)) {
      const children = entriesByDir.get(entry.path)
      if (children) {
        for (const child of children) renderEntry(child, depth + 1, parent)
      } else {
        const loading = document.createElement('div')
        loading.className = 'tree-loading'
        loading.style.paddingLeft = `${(depth + 1) * 12 + 24}px`
        loading.textContent = 'Loading…'
        parent.appendChild(loading)
      }
    }
  }

  function renderPreview() {
    // Tear down any live three.js viewer before clearing the DOM so
    // the WebGL context, RAF loop, and ResizeObserver all release.
    disposeGlbViewer()
    previewEl.innerHTML = ''
    if (!selectedPath) {
      const empty = document.createElement('div')
      empty.className = 'preview-empty'
      empty.textContent = 'Select a file to preview'
      previewEl.appendChild(empty)
      return
    }

    // Breadcrumb + action toolbar
    const bar = document.createElement('div')
    bar.className = 'preview-bar'
    const crumb = document.createElement('div')
    crumb.className = 'preview-crumb'
    crumb.textContent = selectedPath
    bar.appendChild(crumb)
    const meta = document.createElement('span')
    meta.className = 'preview-meta'
    meta.textContent = formatSize(selectedSize || 0)
    bar.appendChild(meta)

    const actions = document.createElement('div')
    actions.className = 'preview-actions'

    const ext = extOf(selectedPath)
    const isImage = IMAGE_EXTS.has(ext)
    const isHtml = HTML_EXTS.has(ext)
    const isGlb = GLB_EXTS.has(ext)
    const isText = !isImage && !isGlb && fileContent !== null && fileError !== 'binary' && fileError !== 'too large'

    // GLB toolbar: four exclusive render-mode buttons. Selecting one
    // swaps every mesh's material on the live viewer.
    if (isGlb) {
      const modes = [
        { id: 'material',  label: 'Material'  },
        { id: 'color',     label: 'Color'     },
        { id: 'clay',      label: 'Clay'      },
        { id: 'wireframe', label: 'Wireframe' },
      ]
      const toggle = document.createElement('div')
      toggle.className = 'preview-toggle'
      for (const m of modes) {
        const btn = document.createElement('button')
        btn.type = 'button'
        btn.className = 'preview-toggle-btn' + (glbMode === m.id ? ' active' : '')
        btn.textContent = m.label
        btn.addEventListener('click', () => {
          if (glbMode === m.id) return
          glbMode = m.id
          if (glbViewer) glbViewer.setMode(m.id)
          // Re-render just the toolbar's active state, not the canvas:
          // a full renderPreview() would dispose + recreate the viewer.
          for (const el of toggle.children) {
            el.classList.toggle('active', el.textContent === m.label)
          }
        })
        toggle.appendChild(btn)
      }
      actions.appendChild(toggle)
    }

    if (isHtml && !editing) {
      const toggle = document.createElement('div')
      toggle.className = 'preview-toggle'
      const previewBtn = document.createElement('button')
      previewBtn.type = 'button'
      previewBtn.className = 'preview-toggle-btn' + (htmlViewMode === 'preview' ? ' active' : '')
      previewBtn.textContent = 'Preview'
      previewBtn.addEventListener('click', () => {
        if (htmlViewMode === 'preview') return
        htmlViewMode = 'preview'
        renderPreview()
        persist()
      })
      const rawBtn = document.createElement('button')
      rawBtn.type = 'button'
      rawBtn.className = 'preview-toggle-btn' + (htmlViewMode === 'raw' ? ' active' : '')
      rawBtn.textContent = 'Raw'
      rawBtn.addEventListener('click', () => {
        if (htmlViewMode === 'raw') return
        htmlViewMode = 'raw'
        renderPreview()
        persist()
      })
      toggle.appendChild(previewBtn)
      toggle.appendChild(rawBtn)
      actions.appendChild(toggle)
    }

    if (isText) {
      if (editing) {
        const saveBtn = document.createElement('button')
        saveBtn.type = 'button'
        saveBtn.className = 'preview-btn primary'
        saveBtn.textContent = saving ? 'Saving…' : 'Save'
        saveBtn.disabled = saving
        saveBtn.addEventListener('click', saveEdit)
        actions.appendChild(saveBtn)

        const cancelBtn = document.createElement('button')
        cancelBtn.type = 'button'
        cancelBtn.className = 'preview-btn'
        cancelBtn.textContent = 'Cancel'
        cancelBtn.addEventListener('click', () => {
          editing = false
          editContent = ''
          renderPreview()
        })
        actions.appendChild(cancelBtn)
      } else {
        const editBtn = document.createElement('button')
        editBtn.type = 'button'
        editBtn.className = 'preview-icon-btn'
        editBtn.title = 'Edit'
        editBtn.innerHTML = svgIcon('edit')
        editBtn.addEventListener('click', () => {
          editing = true
          editContent = fileContent || ''
          renderPreview()
        })
        actions.appendChild(editBtn)
      }
    }

    const dlLink = document.createElement('a')
    dlLink.className = 'preview-icon-btn'
    dlLink.title = 'Download'
    dlLink.innerHTML = svgIcon('download')
    dlLink.href = rawUrl(selectedPath, false)
    dlLink.setAttribute('download', selectedPath.split('/').pop() || '')
    actions.appendChild(dlLink)

    bar.appendChild(actions)
    previewEl.appendChild(bar)

    // Content area
    const content = document.createElement('div')
    content.className = 'preview-content'
    previewEl.appendChild(content)

    if (fileError === 'too large') {
      content.innerHTML = `<div class="preview-error">File too large (${formatSize(selectedSize)}). <a href="${rawUrl(selectedPath, false)}" download>Download</a> instead.</div>`
      return
    }
    if (fileError === 'binary') {
      content.innerHTML = `<div class="preview-error">Binary file (${formatSize(selectedSize)}). <a href="${rawUrl(selectedPath, false)}" download>Download</a> to inspect.</div>`
      return
    }
    if (fileError) {
      content.innerHTML = `<div class="preview-error">Error: ${escapeHtml(fileError)}</div>`
      return
    }

    if (isImage) {
      const wrap = document.createElement('div')
      wrap.className = 'preview-image-wrap'
      const img = document.createElement('img')
      img.src = rawUrl(selectedPath, true)
      img.alt = selectedPath.split('/').pop() || 'image'
      wrap.appendChild(img)
      content.appendChild(wrap)
      return
    }

    if (isGlb) {
      const wrap = document.createElement('div')
      wrap.className = 'preview-glb-wrap'
      content.appendChild(wrap)
      // Show a small "loading" hint while three.js spins up and the
      // bytes stream in. createGlbViewer is async (lazy-imports the
      // ~600 KB three bundle).
      const loading = document.createElement('div')
      loading.className = 'preview-loading'
      loading.textContent = 'Loading 3D model…'
      wrap.appendChild(loading)
      const token = ++glbViewerToken
      const url = rawUrl(selectedPath, true)
      // Dynamic import keeps three.js out of the cold-start bundle.
      import('./glb-viewer.js').then(async ({ createGlbViewer }) => {
        // Bail if the user clicked away before three.js finished
        // loading — disposeGlbViewer already ran on the next render.
        if (token !== glbViewerToken || cancelled) return
        try {
          glbViewer = await createGlbViewer(wrap)
          if (token !== glbViewerToken) {
            try { glbViewer.dispose() } catch {}
            glbViewer = null
            return
          }
          loading.remove()
          await glbViewer.load(url)
          if (token !== glbViewerToken) return
          glbViewer.setMode(glbMode)
        } catch (err) {
          loading.textContent = `Failed to load: ${err?.message || err}`
        }
      }).catch((err) => {
        loading.textContent = `Failed to load three.js: ${err?.message || err}`
      })
      return
    }

    if (fileContent === null) {
      const loading = document.createElement('div')
      loading.className = 'preview-loading'
      loading.textContent = 'Loading…'
      content.appendChild(loading)
      return
    }

    if (editing) {
      const ta = document.createElement('textarea')
      ta.className = 'preview-edit'
      ta.value = editContent
      ta.spellcheck = false
      ta.addEventListener('input', () => { editContent = ta.value })
      ta.addEventListener('keydown', (e) => {
        // Ctrl/Cmd+S → save
        if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
          e.preventDefault()
          saveEdit()
        }
      })
      content.appendChild(ta)
      requestAnimationFrame(() => ta.focus())
      return
    }

    if (isHtml && htmlViewMode === 'preview') {
      const wrap = document.createElement('div')
      wrap.className = 'preview-html-wrap'
      const iframe = document.createElement('iframe')
      iframe.className = 'preview-html-frame'
      // Load the HTML from a path-mirrored serve endpoint so the browser's
      // relative-URL resolution maps `<link href="styles.css">` etc. to sibling
      // project files. allow-same-origin keeps fetch() and same-origin XHR
      // working; allow-scripts/forms/popups keep interactive pages functional.
      iframe.setAttribute(
        'sandbox',
        'allow-scripts allow-same-origin allow-forms allow-popups allow-modals'
      )
      iframe.src = serveUrl(selectedPath)
      iframe.title = selectedPath.split('/').pop() || 'html preview'
      wrap.appendChild(iframe)
      content.appendChild(wrap)
      return
    }

    if (MARKDOWN_EXTS.has(ext) && window.marked && window.DOMPurify) {
      const html = window.marked.parse(fileContent)
      const safe = window.DOMPurify.sanitize(html)
      const md = document.createElement('div')
      md.className = 'preview-md chat-prose'
      md.innerHTML = safe
      // Post-process code blocks for syntax highlighting
      if (window.hljs) {
        md.querySelectorAll('pre code').forEach((codeEl) => {
          try { window.hljs.highlightElement(codeEl) } catch {}
        })
      }
      content.appendChild(md)
      return
    }

    if (window.hljs) {
      const lang = HLJS_LANG_MAP[ext]
      const pre = document.createElement('pre')
      pre.className = 'preview-code'
      const codeEl = document.createElement('code')
      try {
        if (lang) {
          codeEl.innerHTML = window.hljs.highlight(fileContent, { language: lang }).value
        } else {
          codeEl.textContent = fileContent
        }
      } catch {
        codeEl.textContent = fileContent
      }
      pre.appendChild(codeEl)
      content.appendChild(pre)
      return
    }

    const pre = document.createElement('pre')
    pre.className = 'preview-code'
    pre.textContent = fileContent
    content.appendChild(pre)
  }

  async function saveEdit() {
    if (!selectedPath || saving) return
    saving = true
    renderPreview()
    try {
      await apiSave(selectedPath, editContent)
      fileContent = editContent
      selectedSize = new TextEncoder().encode(editContent).length
      editing = false
      editContent = ''
      saving = false
      renderPreview()
      refreshAll().catch(() => {})
    } catch (err) {
      saving = false
      alert('Save failed: ' + err.message)
      renderPreview()
    }
  }

  // --- Upload ---

  async function handleUpload(files, destPath) {
    if (!files.length) return
    uploading = true
    try {
      for (const file of files) {
        await apiUpload(file, destPath)
      }
      // Force a tree refresh so newly-uploaded files show up without waiting
      // for the next poll tick (their hash will differ from cached).
      const dirsToReload = ['', ...Array.from(expanded)]
      await Promise.all(dirsToReload.map((d) => loadDir(d, { forceRender: true })))
    } catch (err) {
      alert('Upload failed: ' + err.message)
    } finally {
      uploading = false
    }
  }

  // Drag-drop on container — use a nested counter so child enter/leave events
  // don't toggle visibility unexpectedly.
  function onDragEnter(e) {
    e.preventDefault()
    dragCounter++
    container.classList.add('dragging')
  }
  function onDragLeave(e) {
    e.preventDefault()
    dragCounter = Math.max(0, dragCounter - 1)
    if (dragCounter === 0) container.classList.remove('dragging')
  }
  function onDragOver(e) {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
  }
  async function onDrop(e) {
    e.preventDefault()
    dragCounter = 0
    container.classList.remove('dragging')
    if (remote) return
    const files = e.dataTransfer.files
    if (!files?.length) return
    const dest = selectedPath ? dirOf(selectedPath) : ''
    await handleUpload(Array.from(files), dest)
  }

  container.addEventListener('dragenter', onDragEnter)
  container.addEventListener('dragleave', onDragLeave)
  container.addEventListener('dragover', onDragOver)
  container.addEventListener('drop', onDrop)

  // --- Persistence ---

  function persist() {
    if (remote) return // remote projects don't carry meaningful explorer state
    saveExplorerState(project, { selectedPath, htmlViewMode, expanded })
  }

  /** Restore persisted state: expand ancestors of selectedPath then select it. */
  async function restorePersisted() {
    const persisted = loadExplorerState(project)
    if (!persisted) return

    // Restore expanded set first so the tree shows correctly even if the file
    // load below fails (e.g., file was deleted since last visit).
    for (const p of persisted.expanded) expanded.add(p)

    // Load each persisted dir (skip root — already loaded)
    const dirsToLoad = persisted.expanded.filter((p) => p && !entriesByDir.has(p))
    for (const d of dirsToLoad) {
      await loadDir(d, { forceRender: true })
      if (cancelled || project !== projectId) return
    }

    if (persisted.selectedPath) {
      // Expand each ancestor of the persisted file (so it appears in the tree)
      const parts = persisted.selectedPath.split('/')
      for (let i = 1; i < parts.length; i++) {
        const ancestor = parts.slice(0, i).join('/')
        if (!expanded.has(ancestor)) {
          expanded.add(ancestor)
          if (!entriesByDir.has(ancestor)) await loadDir(ancestor, { forceRender: true })
          if (cancelled || project !== projectId) return
        }
      }
      htmlViewMode = persisted.htmlViewMode === 'raw' ? 'raw' : 'preview'
      const parent = persisted.selectedPath.includes('/')
        ? persisted.selectedPath.slice(0, persisted.selectedPath.lastIndexOf('/'))
        : ''
      const siblings = entriesByDir.get(parent) || []
      const match = siblings.find((e) => e.path === persisted.selectedPath)
      if (match) {
        await selectFile(persisted.selectedPath, match.size || 0, { preserveHtmlViewMode: true, force: true })
      } else {
        render()
      }
    } else {
      render()
    }
  }

  // Boot
  ;(async () => {
    await loadDir('', { forceRender: true })
    if (cancelled || project !== projectId) return
    if (!remote) await restorePersisted()
    startPolling()
  })()

  return {
    destroy() {
      cancelled = true
      if (pollTimer) clearInterval(pollTimer)
      container.removeEventListener('dragenter', onDragEnter)
      container.removeEventListener('dragleave', onDragLeave)
      container.removeEventListener('dragover', onDragOver)
      container.removeEventListener('drop', onDrop)
      container.innerHTML = ''
      container.classList.remove('explorer', 'dragging')
    },
    /**
     * Feature 2: open a file path programmatically — called when user clicks
     * a path link in a chat bubble (nanocode:open-in-explorer event).
     *
     * The path may be:
     *   - An absolute path starting with / (cross-project or codex_work)
     *   - A ~/... path (expand to home-root absolute path)
     *   - A repo-relative path like "server/index.js"
     *
     * Absolute-path strategy (method C):
     *   1. Fetch all projects; find one whose cwd is a prefix of the path.
     *      If found, switch to that project then navigate to the relative path.
     *   2. Otherwise, pass the absolute path directly to the backend — the server
     *      will sandbox it against the home root (/storage/home/zhiningjiao).
     *      The file is previewed using the current project's API endpoint, which
     *      now accepts absolute paths via resolveWithFallback().
     *
     * Relative paths: navigate the existing tree as before.
     */
    async openPath(rawPath) {
      if (remote || cancelled) return
      let filePath = rawPath

      // Expand ~/ to absolute home path
      if (filePath.startsWith('~/')) {
        filePath = '/storage/home/zhiningjiao/' + filePath.slice(2)
      }

      // ── Absolute path handling ────────────────────────────────────────────
      if (filePath.startsWith('/')) {
        // Try to find a project whose cwd covers this path
        let projects = []
        try {
          projects = await fetch('/api/projects').then((r) => r.json())
        } catch {}

        let bestProject = null
        let bestRelPath = null
        for (const p of projects) {
          if (!p.cwd || p.ssh_host) continue
          const cwd = p.cwd.endsWith('/') ? p.cwd : p.cwd + '/'
          if (filePath.startsWith(cwd)) {
            const rel = filePath.slice(cwd.length)
            // Prefer the project with the longest matching cwd (most specific)
            if (!bestProject || p.cwd.length > bestProject.cwd.length) {
              bestProject = p
              bestRelPath = rel
            }
          }
        }

        if (bestProject && bestRelPath !== null && bestProject.id === project) {
          // Same project: navigate within the existing tree (highlight + preview).
          // If the path belongs to a *different* project, skip the tree nav entirely
          // so we never dispatch switch-project and never change the user's working context.
          const parts = bestRelPath.split('/').filter(Boolean)
          if (!parts.length) return
          try {
            let current = ''
            for (let i = 0; i < parts.length - 1; i++) {
              const next = current ? `${current}/${parts[i]}` : parts[i]
              if (!expanded.has(next)) {
                await expandDir(next)
                if (cancelled) return
              }
              current = next
            }
            const parentDir = parts.slice(0, -1).join('/')
            const siblings = entriesByDir.get(parentDir) || []
            const match = siblings.find((e) => e.path === bestRelPath || e.name === parts[parts.length - 1])
            if (match) {
              renderTree()
              await selectFile(match.path, match.size || 0, { force: true })
              return
            }
          } catch {}
        }

        // Fallback: pass the absolute path directly — backend handles home-root sandbox
        // The file is loaded as if selectedPath were the absolute path.
        // Tree won't highlight it (it's outside cwd) but preview will work.
        try {
          await selectFile(filePath, 0, { force: true })
        } catch {}
        return
      }

      // ── Relative path: navigate the tree ─────────────────────────────────
      const parts = filePath.split('/').filter(Boolean)
      if (!parts.length) return

      try {
        let current = ''
        for (let i = 0; i < parts.length - 1; i++) {
          const next = current ? `${current}/${parts[i]}` : parts[i]
          if (!expanded.has(next)) {
            await expandDir(next)
            if (cancelled) return
          }
          current = next
        }
        const parentDir = parts.slice(0, -1).join('/')
        const siblings = entriesByDir.get(parentDir) || entriesByDir.get('') || []
        const match = siblings.find((e) => e.path === filePath || e.name === parts[parts.length - 1])
        if (match) {
          renderTree()
          await selectFile(match.path, match.size || 0, { force: true })
          return
        }
      } catch {}

      // Last resort: pass as-is
      try {
        await selectFile(filePath, 0, { force: true })
      } catch {}
    },
    async switchProject(newProjectId) {
      persist()
      project = newProjectId
      projectId = newProjectId
      entriesByDir = new Map()
      dirHashes = new Map()
      expanded = new Set()
      remote = false
      selectedPath = null
      selectedSize = 0
      fileContent = null
      fileError = null
      editing = false
      editContent = ''
      htmlViewMode = 'preview'
      render()
      await loadDir('', { forceRender: true })
      if (!remote) await restorePersisted()
    },
  }
}

// --- SVG icons (inline, currentColor) ---

function svgIcon(name) {
  const stroke = 'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"'
  switch (name) {
    case 'chev-right':
      return `<svg width="10" height="10" viewBox="0 0 24 24" ${stroke}><polyline points="9 18 15 12 9 6"/></svg>`
    case 'chev-down':
      return `<svg width="10" height="10" viewBox="0 0 24 24" ${stroke}><polyline points="6 9 12 15 18 9"/></svg>`
    case 'folder':
      return `<svg width="14" height="14" viewBox="0 0 24 24" ${stroke}><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>`
    case 'folder-open':
      return `<svg width="14" height="14" viewBox="0 0 24 24" ${stroke}><path d="M6 14l-3 5h17a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-9l-2-3H4a2 2 0 0 0-2 2v12"/></svg>`
    case 'file':
      return `<svg width="14" height="14" viewBox="0 0 24 24" ${stroke}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`
    case 'upload':
      return `<svg width="14" height="14" viewBox="0 0 24 24" ${stroke}><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>`
    case 'download':
      return `<svg width="14" height="14" viewBox="0 0 24 24" ${stroke}><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`
    case 'refresh':
      return `<svg width="14" height="14" viewBox="0 0 24 24" ${stroke}><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>`
    case 'edit':
      return `<svg width="14" height="14" viewBox="0 0 24 24" ${stroke}><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`
    default:
      return ''
  }
}
