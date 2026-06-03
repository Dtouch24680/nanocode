export const state = {
  projects: [],
  activeProjectId: null,
  tabs: [],
  activeTabId: null,
  cliProvider: 'claude',
  fontSize: 14,
  renderMode: 'block',
}

// Expose state globally so tab-manager.js (which imports state separately)
// can read renderMode without an additional API call.
window.__nanocodeState = state
