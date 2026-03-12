/**
 * Settings view for terminal preferences.
 *
 * Architecture: docs/architecture.md#frontend-architecture
 */

import { state } from './state.js'
import { updateSetting } from './api.js'
import { isInitialized, switchProvider, updateProviderLabels } from './terminal-view.js'

const cliProviderGroup = document.getElementById('cli-provider-group')
const cliSaveBtn = document.getElementById('cli-save-btn')
const cliStatusEl = document.getElementById('cli-status')

function showStatus(el, text, isError = false) {
  el.textContent = text
  el.className = 'settings-status' + (isError ? ' error' : ' success')
  setTimeout(() => {
    el.textContent = ''
  }, 3000)
}

/**
 * Sync the settings form from current state.
 *
 * Architecture: public/docs/state-management.md#tab-switching
 */
export async function loadSettings() {
  const radios = cliProviderGroup?.querySelectorAll('input[name="cli-provider"]')
  if (!radios) return

  for (const radio of radios) {
    radio.checked = radio.value === state.cliProvider
  }
}

if (cliSaveBtn) {
  cliSaveBtn.addEventListener('click', async () => {
    const selected = cliProviderGroup?.querySelector('input[name="cli-provider"]:checked')
    if (!selected) return

    try {
      await updateSetting('cli_provider', selected.value)
      state.cliProvider = selected.value
      updateProviderLabels()
      if (isInitialized()) switchProvider()
      showStatus(cliStatusEl, 'Saved')
    } catch (err) {
      showStatus(cliStatusEl, err.message, true)
    }
  })
}
