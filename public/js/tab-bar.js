/**
 * Tab bar — switches between Tasks, Terminal, and Settings views.
 * Lazy-initializes the terminal view on first visit.
 */

import { state } from './state.js'

let _onTabSwitch = null

const tabs = ['tasks', 'terminal', 'settings']

/**
 * Initialize the tab bar.
 * @param {function} onTabSwitch — callback(tabName) when tab changes
 */
export function initTabBar(onTabSwitch) {
  _onTabSwitch = onTabSwitch

  for (const tab of tabs) {
    const btn = document.getElementById(`tab-${tab}`)
    if (btn) btn.addEventListener('click', () => switchTab(tab))
  }

  // Keyboard shortcuts: Cmd/Ctrl+1 → tasks, Cmd/Ctrl+2 → terminal, Cmd/Ctrl+3 → settings
  document.addEventListener('keydown', (e) => {
    if (!(e.metaKey || e.ctrlKey)) return
    const idx = parseInt(e.key, 10) - 1
    if (idx >= 0 && idx < tabs.length) {
      e.preventDefault()
      switchTab(tabs[idx])
    }
  })
}

export function switchTab(tab) {
  state.activeTab = tab

  for (const t of tabs) {
    const btn = document.getElementById(`tab-${t}`)
    const content = document.getElementById(`${t}-tab`)
    if (btn) btn.classList.toggle('active', t === tab)
    if (content) content.hidden = t !== tab
  }

  if (_onTabSwitch) _onTabSwitch(tab)
}
