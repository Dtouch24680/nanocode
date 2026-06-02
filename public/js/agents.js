/**
 * Agent manager right-side drawer.
 * Loads from /api/agents, persists via PUT /api/agents.
 */

let _agents = []

export function initAgentDrawer() {
  const drawer = document.getElementById('agent-drawer')
  if (!drawer) return

  const backdrop = document.getElementById('agent-drawer-backdrop')
  const toggleBtn = document.getElementById('agent-drawer-toggle')
  const closeBtn = document.getElementById('agent-drawer-close')
  const discoverBtn = document.getElementById('agent-discover-btn')
  const addForm = document.getElementById('agent-add-form')

  function open() {
    drawer.classList.add('open')
    backdrop?.classList.add('open')
    toggleBtn?.classList.add('active')
    _loadAgents()
  }
  function close() {
    drawer.classList.remove('open')
    backdrop?.classList.remove('open')
    toggleBtn?.classList.remove('active')
  }

  toggleBtn?.addEventListener('click', () => drawer.classList.contains('open') ? close() : open())
  closeBtn?.addEventListener('click', close)
  backdrop?.addEventListener('click', close)
  discoverBtn?.addEventListener('click', _discover)

  addForm?.addEventListener('submit', async (e) => {
    e.preventDefault()
    const name = document.getElementById('agent-add-name')?.value.trim()
    const type = document.getElementById('agent-add-type')?.value || 'other'
    const tmuxWindow = document.getElementById('agent-add-tmux')?.value.trim() || ''
    if (!name) return
    _agents = [..._agents, { id: crypto.randomUUID(), name, type, tmuxWindow }]
    await _save()
    if (document.getElementById('agent-add-name')) document.getElementById('agent-add-name').value = ''
    if (document.getElementById('agent-add-tmux')) document.getElementById('agent-add-tmux').value = ''
  })
}

async function _loadAgents() {
  try {
    _agents = await fetch('/api/agents').then(r => r.json())
    _render()
  } catch {}
}

function _render() {
  const list = document.getElementById('agent-list')
  if (!list) return

  // Preserve discover section if present
  const discoverSection = list.querySelector('.agent-discover-section')
  list.innerHTML = ''
  if (discoverSection) list.appendChild(discoverSection)

  if (!_agents.length) {
    const empty = document.createElement('div')
    empty.className = 'agent-list-empty'
    empty.textContent = 'No agents yet. Add one below or click ⟳ to discover from tmux.'
    list.appendChild(empty)
    return
  }

  for (const agent of _agents) {
    const item = document.createElement('div')
    item.className = 'agent-item'
    item.dataset.id = agent.id
    item.innerHTML = `
      <span class="agent-status-dot ${agent.status || 'unknown'}"></span>
      <div class="agent-info">
        <span class="agent-name">${_esc(agent.name)}</span>
        <div class="agent-meta">
          <span class="agent-type-badge ${agent.type}">${_esc(agent.type)}</span>
          ${agent.tmuxWindow ? `<span class="agent-tmux-label">${_esc(agent.tmuxWindow)}</span>` : ''}
        </div>
      </div>
      <div class="agent-actions">
        <button type="button" class="svc-btn agent-edit-btn" title="Rename">&#9998;</button>
        <button type="button" class="svc-btn agent-del-btn" title="Delete">&#10005;</button>
      </div>`

    // Click agent-info → close drawer (terminal is the default view in upstream)
    item.querySelector('.agent-info').addEventListener('click', () => {
      document.getElementById('agent-drawer')?.classList.remove('open')
      document.getElementById('agent-drawer-backdrop')?.classList.remove('open')
      document.getElementById('agent-drawer-toggle')?.classList.remove('active')
    })

    item.querySelector('.agent-del-btn').addEventListener('click', async (e) => {
      e.stopPropagation()
      _agents = _agents.filter(a => a.id !== agent.id)
      await _save()
    })

    item.querySelector('.agent-edit-btn').addEventListener('click', (e) => {
      e.stopPropagation()
      const nameEl = item.querySelector('.agent-name')
      const old = nameEl.textContent
      nameEl.innerHTML = `<input type="text" class="settings-input" value="${_esc(old)}" style="width:100%;font-size:12px;padding:2px 6px" />`
      const input = nameEl.querySelector('input')
      input.focus(); input.select()
      async function commit() {
        const newName = input.value.trim() || old
        const a = _agents.find(a => a.id === agent.id)
        if (a && a.name !== newName) { a.name = newName; await _save(); } else { _render() }
      }
      input.addEventListener('blur', commit)
      input.addEventListener('keydown', ev => {
        if (ev.key === 'Enter') { ev.preventDefault(); commit() }
        if (ev.key === 'Escape') _render()
      })
    })

    list.appendChild(item)
  }
}

async function _discover() {
  const list = document.getElementById('agent-list')
  if (!list) return
  // Remove existing discover section
  list.querySelector('.agent-discover-section')?.remove()
  try {
    const windows = await fetch('/api/agents/discover').then(r => r.json())
    if (!windows.length) return
    const existingTargets = new Set(_agents.map(a => a.tmuxWindow).filter(Boolean))
    const fresh = windows.filter(w => !existingTargets.has(w.tmuxWindow))
    if (!fresh.length) return

    const section = document.createElement('div')
    section.className = 'agent-discover-section'
    section.innerHTML = `<div class="agent-discover-title">Discovered — click + to add</div>` +
      fresh.map(w => `
        <div class="agent-discover-item">
          <span class="agent-type-badge ${w.type}">${_esc(w.type)}</span>
          <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${_esc(w.name)}</span>
          <button type="button" class="btn btn-secondary" data-tmux="${_esc(w.tmuxWindow)}" data-name="${_esc(w.name)}" data-type="${w.type}">+</button>
        </div>`).join('')

    section.querySelectorAll('button[data-tmux]').forEach(btn => {
      btn.addEventListener('click', async () => {
        _agents = [..._agents, {
          id: crypto.randomUUID(),
          name: btn.dataset.name,
          type: btn.dataset.type,
          tmuxWindow: btn.dataset.tmux,
        }]
        await _save()
        section.remove()
      })
    })

    list.prepend(section)
  } catch {}
}

async function _save() {
  try {
    await fetch('/api/agents', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(_agents.map(({ status, ...a }) => a)),
    })
    await _loadAgents()
  } catch {}
}

function _esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
