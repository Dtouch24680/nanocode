/**
 * Mutable application state for the reduced terminal workspace.
 *
 * The sidebar, tab bar, settings screen, and terminal controller all
 * read from this object directly.
 *
 * Architecture: public/docs/state-management.md
 */

export const state = {
  projects: [],
  activeProjectId: null,
  activeTab: 'terminal',
  cliProvider: 'claude',
}
