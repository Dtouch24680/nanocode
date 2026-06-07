/**
 * Theme mechanism regression tests.
 *
 * Validates:
 * 1. theme.js uses setAttribute for BOTH dark AND light — never removeAttribute.
 * 2. [data-theme="light"] CSS block exists in style.css so light rules fire.
 * 3. Default theme is dark (detectInitial returns "dark" when no localStorage).
 *
 * These tests work by inspecting the source text — no browser DOM needed.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'

const __dir = dirname(fileURLToPath(import.meta.url))
const root = join(__dir, '..', '..')
const themeJs = readFileSync(join(root, 'public', 'js', 'theme.js'), 'utf8')
const styleCss = readFileSync(join(root, 'public', 'style.css'), 'utf8')

describe('theme mechanism', () => {
  it('theme.js uses setAttribute for both dark and light (not removeAttribute)', () => {
    // The applyTheme function must call setAttribute with data-theme for all themes.
    // It may use a ternary like: setAttribute('data-theme', theme === 'dark' ? 'dark' : 'light')
    // or separate branches — either way setAttribute('data-theme', ...) must appear.
    assert.ok(
      themeJs.includes("setAttribute('data-theme'") ||
      themeJs.includes('setAttribute("data-theme"'),
      'theme.js must call setAttribute with data-theme'
    )
    // Light should NOT use removeAttribute — that was the bug.
    assert.ok(
      !themeJs.includes('removeAttribute'),
      'theme.js must NOT use removeAttribute — light must use setAttribute("data-theme","light")'
    )
  })

  it('theme.js default is dark (no stored preference → dark)', () => {
    // detectInitial falls through to return 'dark'
    assert.ok(
      themeJs.includes("return 'dark'") || themeJs.includes('return "dark"'),
      'detectInitial should return dark as default'
    )
  })

  it('style.css has [data-theme="light"] block for light-mode CSS rules', () => {
    assert.ok(
      styleCss.includes('[data-theme="light"]'),
      'style.css must contain [data-theme="light"] rules'
    )
  })

  it('style.css [data-theme="light"] hljs rules exist', () => {
    assert.ok(
      styleCss.includes('[data-theme="light"] .hljs-keyword'),
      'style.css must have [data-theme="light"] hljs-keyword rule'
    )
    assert.ok(
      styleCss.includes('[data-theme="light"] .hljs-string'),
      'style.css must have [data-theme="light"] hljs-string rule'
    )
  })

  it('style.css has [data-theme="dark"] block for dark-mode overrides', () => {
    assert.ok(
      styleCss.includes('[data-theme="dark"]'),
      'style.css must retain [data-theme="dark"] rules'
    )
  })

  it('style.css light mode overrides settings-panel background', () => {
    // Check that settings-panel has a light-mode override (not just dark hardcoded)
    assert.ok(
      styleCss.includes('[data-theme="light"] .settings-panel'),
      'style.css must have light-mode override for .settings-panel'
    )
  })

  it('style.css light mode overrides agent-drawer background', () => {
    assert.ok(
      styleCss.includes('[data-theme="light"] .agent-drawer'),
      'style.css must have light-mode override for .agent-drawer'
    )
  })
})
