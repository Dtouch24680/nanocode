/**
 * Settings view — Slack webhook configuration.
 */

const urlInput = document.getElementById('slack-webhook-url')
const saveBtn = document.getElementById('slack-save-btn')
const testBtn = document.getElementById('slack-test-btn')
const statusEl = document.getElementById('slack-status')

let loaded = false

function showStatus(text, isError = false) {
  statusEl.textContent = text
  statusEl.className = 'settings-status' + (isError ? ' error' : ' success')
  setTimeout(() => { statusEl.textContent = '' }, 3000)
}

/**
 * Load current Slack settings from server (called on first tab visit).
 */
export async function loadSettings() {
  if (loaded) return
  loaded = true
  try {
    const res = await fetch('/api/slack')
    const data = await res.json()
    urlInput.value = data.webhookUrl || ''
  } catch {
    // non-critical
  }
}

saveBtn.addEventListener('click', async () => {
  try {
    const res = await fetch('/api/slack', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ webhookUrl: urlInput.value.trim() }),
    })
    if (!res.ok) throw new Error('Save failed')
    showStatus('Saved')
  } catch (err) {
    showStatus(err.message, true)
  }
})

testBtn.addEventListener('click', async () => {
  try {
    const res = await fetch('/api/slack/test', { method: 'POST' })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || 'Test failed')
    showStatus('Test sent')
  } catch (err) {
    showStatus(err.message, true)
  }
})
