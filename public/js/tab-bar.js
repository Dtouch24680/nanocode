/**
 * Tab bar — switches between Tasks and Terminal views.
 * Lazy-initializes the terminal view on first visit.
 */

import { state } from './state.js'

let _onTabSwitch = null

/**
 * Initialize the tab bar.
 * @param {function} onTabSwitch — callback(tabName) when tab changes
 */
export function initTabBar(onTabSwitch) {
  _onTabSwitch = onTabSwitch

  const tasksBtn = document.getElementById('tab-tasks')
  const terminalBtn = document.getElementById('tab-terminal')

  tasksBtn.addEventListener('click', () => switchTab('tasks'))
  terminalBtn.addEventListener('click', () => switchTab('terminal'))

  // Keyboard shortcuts: Cmd/Ctrl+1 → tasks, Cmd/Ctrl+2 → terminal
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === '1') {
      e.preventDefault()
      switchTab('tasks')
    } else if ((e.metaKey || e.ctrlKey) && e.key === '2') {
      e.preventDefault()
      switchTab('terminal')
    }
  })
}

export function switchTab(tab) {
  state.activeTab = tab

  const tasksBtn = document.getElementById('tab-tasks')
  const terminalBtn = document.getElementById('tab-terminal')
  const tasksTab = document.getElementById('tasks-tab')
  const terminalTab = document.getElementById('terminal-tab')

  tasksBtn.classList.toggle('active', tab === 'tasks')
  terminalBtn.classList.toggle('active', tab === 'terminal')
  tasksTab.hidden = tab !== 'tasks'
  terminalTab.hidden = tab !== 'terminal'

  if (_onTabSwitch) _onTabSwitch(tab)
}
