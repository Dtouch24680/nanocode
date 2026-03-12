/**
 * Tab bar for the reduced workspace.
 *
 * Architecture: public/docs/state-management.md#tab-switching
 */

import { state } from './state.js'

let _onTabSwitch = null

const tabs = ['terminal', 'settings']

/**
 * Initialize the tab bar.
 *
 * Architecture: public/docs/state-management.md#tab-switching
 */
export function initTabBar(onTabSwitch) {
  _onTabSwitch = onTabSwitch

  for (const tab of tabs) {
    const btn = document.getElementById(`tab-${tab}`)
    if (btn) btn.addEventListener('click', () => switchTab(tab))
  }

  document.addEventListener('keydown', (event) => {
    if (!(event.metaKey || event.ctrlKey)) return
    const idx = parseInt(event.key, 10) - 1
    if (idx >= 0 && idx < tabs.length) {
      event.preventDefault()
      switchTab(tabs[idx])
    }
  })
}

/**
 * Switch the visible tab.
 *
 * Architecture: public/docs/state-management.md#tab-switching
 */
export function switchTab(tab) {
  state.activeTab = tab

  for (const current of tabs) {
    const btn = document.getElementById(`tab-${current}`)
    const content = document.getElementById(`${current}-tab`)
    if (btn) btn.classList.toggle('active', current === tab)
    if (content) content.hidden = current !== tab
  }

  if (_onTabSwitch) _onTabSwitch(tab)
}
