/**
 * Shared DOM helpers: element creation, markdown rendering, formatters.
 *
 * Architecture: public/docs/event-rendering.md
 */

import { marked } from 'marked'
import DOMPurify from 'dompurify'

/**
 * Create a DOM element with attributes and children.
 *
 * @param {string} tag
 * @param {object} [attrs]
 * @param {(string|Node)[]} [children]
 * @returns {HTMLElement}
 */
export function el(tag, attrs = {}, children = []) {
  const element = document.createElement(tag)

  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'className') {
      element.className = value
    } else if (key === 'textContent') {
      element.textContent = value
    } else if (key === 'innerHTML') {
      element.innerHTML = value
    } else if (key.startsWith('on')) {
      element.addEventListener(key.slice(2).toLowerCase(), value)
    } else {
      element.setAttribute(key, value)
    }
  }

  for (const child of children) {
    if (typeof child === 'string') {
      element.appendChild(document.createTextNode(child))
    } else if (child) {
      element.appendChild(child)
    }
  }

  return element
}

/**
 * Render markdown to sanitized HTML.
 *
 * @param {string} text
 * @returns {string} Safe HTML string
 */
export function md(text) {
  if (!text) return ''
  return DOMPurify.sanitize(marked.parse(text))
}

/**
 * Format a cost in USD.
 *
 * @param {number} cost
 * @returns {string}
 */
export function formatCost(cost) {
  if (!cost || cost === 0) return '$0.00'
  if (cost < 0.01) return '<$0.01'
  return `$${cost.toFixed(2)}`
}

/**
 * Format a timestamp as relative time.
 *
 * @param {number} timestamp — ms since epoch
 * @returns {string}
 */
export function timeAgo(timestamp) {
  if (!timestamp) return ''
  const seconds = Math.floor((Date.now() - timestamp) / 1000)
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}
