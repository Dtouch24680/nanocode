/**
 * Per-user JSON data store for the worker.
 *
 * Schema: { projects, tabs, settings } — same shape as the single-user
 * store; system mode writes one of these per user under
 * $HOME/.nanocode/data.json. Atomic writes via tmp + rename, mode 0600.
 * Unknown top-level keys are silently dropped on load (forward-compat).
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  chmodSync,
} from 'node:fs'
import { dirname } from 'node:path'

function emptyData() {
  return { projects: [], tabs: {}, settings: {} }
}

export class DataStore {
  constructor({ path }) {
    if (!path) throw new Error('DataStore requires { path }')
    this.path = path
  }

  load() {
    if (!existsSync(this.path)) {
      this._initFile()
      return emptyData()
    }
    try {
      const raw = readFileSync(this.path, 'utf-8')
      const data = JSON.parse(raw)
      return this._normalize(data)
    } catch {
      // Corrupt file — return empty rather than crash; the next write
      // overwrites with valid JSON.
      return emptyData()
    }
  }

  saveProjects(projects) {
    const data = this.load()
    data.projects = Array.isArray(projects) ? projects : []
    this._write(data)
  }

  saveTabs(projectId, tabs) {
    const data = this.load()
    if (!data.tabs || typeof data.tabs !== 'object') data.tabs = {}
    data.tabs[projectId] = Array.isArray(tabs) ? tabs : []
    this._write(data)
  }

  saveSettings(settings) {
    const data = this.load()
    data.settings = settings && typeof settings === 'object' ? settings : {}
    this._write(data)
  }

  /** Replace the entire stored object. */
  saveAll(data) {
    this._write(this._normalize(data))
  }

  close() { /* no-op for JSON */ }

  // --- Internals ---

  _initFile() {
    const dir = dirname(this.path)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
    this._write(emptyData())
  }

  _normalize(data) {
    if (!data || typeof data !== 'object') return emptyData()
    return {
      projects: Array.isArray(data.projects) ? data.projects : [],
      tabs: data.tabs && typeof data.tabs === 'object' ? data.tabs : {},
      settings: data.settings && typeof data.settings === 'object' ? data.settings : {},
    }
  }

  _write(data) {
    const dir = dirname(this.path)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
    const tmp = this.path + '.tmp'
    writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 })
    try { chmodSync(tmp, 0o600) } catch {}
    renameSync(tmp, this.path)
    try { chmodSync(this.path, 0o600) } catch {}
  }
}
