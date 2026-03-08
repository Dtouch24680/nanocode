/**
 * Settings view — CLI provider + Slack webhook configuration.
 */

import { state } from './state.js'
import { updateSetting } from './api.js'

// --- CLI Provider ---

const cliProviderGroup = document.getElementById('cli-provider-group')
const cliSaveBtn = document.getElementById('cli-save-btn')
const cliStatusEl = document.getElementById('cli-status')

// --- Slack ---

const urlInput = document.getElementById('slack-webhook-url')
const slackSaveBtn = document.getElementById('slack-save-btn')
const slackTestBtn = document.getElementById('slack-test-btn')
const slackStatusEl = document.getElementById('slack-status')

let loaded = false

function showStatus(el, text, isError = false) {
  el.textContent = text
  el.className = 'settings-status' + (isError ? ' error' : ' success')
  setTimeout(() => {
    el.textContent = ''
  }, 3000)
}

/**
 * Load current settings from server (called on first tab visit).
 */
export async function loadSettings() {
  if (loaded) return
  loaded = true

  // Set CLI provider radio to match current state
  const radios = cliProviderGroup?.querySelectorAll('input[name="cli-provider"]')
  if (radios) {
    for (const r of radios) {
      r.checked = r.value === state.cliProvider
    }
  }

  // Load Slack webhook URL
  try {
    const res = await fetch('/api/slack')
    const data = await res.json()
    if (urlInput) urlInput.value = data.webhookUrl || ''
  } catch {
    // non-critical
  }
}

// CLI provider save
if (cliSaveBtn) {
  cliSaveBtn.addEventListener('click', async () => {
    const selected = cliProviderGroup?.querySelector('input[name="cli-provider"]:checked')
    if (!selected) return
    try {
      await updateSetting('cli_provider', selected.value)
      showStatus(cliStatusEl, 'Saved')
    } catch (err) {
      showStatus(cliStatusEl, err.message, true)
    }
  })
}

// Slack save
if (slackSaveBtn) {
  slackSaveBtn.addEventListener('click', async () => {
    try {
      const res = await fetch('/api/slack', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ webhookUrl: urlInput.value.trim() }),
      })
      if (!res.ok) throw new Error('Save failed')
      showStatus(slackStatusEl, 'Saved')
    } catch (err) {
      showStatus(slackStatusEl, err.message, true)
    }
  })
}

// Slack test
if (slackTestBtn) {
  slackTestBtn.addEventListener('click', async () => {
    try {
      const res = await fetch('/api/slack/test', { method: 'POST' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Test failed')
      showStatus(slackStatusEl, 'Test sent')
    } catch (err) {
      showStatus(slackStatusEl, err.message, true)
    }
  })
}
