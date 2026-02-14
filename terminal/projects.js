/**
 * Project CRUD — persisted to terminal/projects.json.
 * Projects define a name and working directory for terminal sessions.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { cwd } from 'node:process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROJECTS_PATH = join(__dirname, 'projects.json')

function getStarterProject() {
  const workdir = cwd()
  return { name: basename(workdir) || 'project', cwd: workdir }
}

function load() {
  if (!existsSync(PROJECTS_PATH)) {
    const starter = getStarterProject()
    const initial = [{ id: randomUUID(), name: starter.name, cwd: starter.cwd }]
    writeFileSync(PROJECTS_PATH, JSON.stringify(initial, null, 2), 'utf8')
    return initial
  }
  const raw = readFileSync(PROJECTS_PATH, 'utf8')
  return JSON.parse(raw)
}

function save(projects) {
  writeFileSync(PROJECTS_PATH, JSON.stringify(projects, null, 2), 'utf8')
}

/**
 * @returns {Array<{ id: string, name: string, cwd: string }>}
 */
export function list() {
  return load()
}

/**
 * @param {string} id
 * @returns {{ id: string, name: string, cwd: string } | null}
 */
export function get(id) {
  const projects = load()
  return projects.find((p) => p.id === id) ?? null
}

/**
 * @param {string} name
 * @param {string} cwd
 * @returns {{ id: string, name: string, cwd: string }}
 */
export function create(name, cwd) {
  const projects = load()
  const project = { id: randomUUID(), name, cwd }
  projects.push(project)
  save(projects)
  return project
}

/**
 * @param {string} id
 */
export function remove(id) {
  const projects = load().filter((p) => p.id !== id)
  save(projects)
}
