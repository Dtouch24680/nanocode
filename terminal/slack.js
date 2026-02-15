/**
 * Minimal Slack webhook notifications.
 * Webhook URL is read from SLACK_WEBHOOK_URL env var or settings file.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SETTINGS_PATH = join(__dirname, 'slack-settings.json')

let webhookUrl = process.env.SLACK_WEBHOOK_URL || ''

// Load persisted webhook URL on startup
try {
  if (existsSync(SETTINGS_PATH)) {
    const data = JSON.parse(readFileSync(SETTINGS_PATH, 'utf-8'))
    if (data.webhookUrl) webhookUrl = data.webhookUrl
  }
} catch { /* ignore */ }

export function getWebhookUrl() {
  return webhookUrl
}

export function setWebhookUrl(url) {
  webhookUrl = url
  try {
    writeFileSync(SETTINGS_PATH, JSON.stringify({ webhookUrl: url }), 'utf-8')
  } catch { /* ignore */ }
}

/**
 * Send a Slack notification. Silently no-ops if no webhook URL is configured.
 * @param {string} text — message text (supports Slack mrkdwn)
 */
export async function notify(text) {
  if (!webhookUrl) return
  try {
    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    })
  } catch {
    // fire-and-forget — don't crash on network errors
  }
}
