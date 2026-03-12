/**
 * URL slug utilities for hash-based routing.
 *
 * Route structure:
 *   #/                    — host picker
 *   #/<host>              — project picker
 *   #/<host>/<project>    — workspace
 */

/** Convert a name to a URL-safe slug. */
export function slugify(str) {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'unnamed'
}

/** Get the host slug for a project. */
export function hostSlug(project) {
  return project.ssh_host ? slugify(project.ssh_host) : 'local'
}

/** Get the project slug, deduplicating within its host group. */
export function projectSlug(project, allProjects) {
  const host = hostSlug(project)
  const siblings = allProjects.filter((p) => hostSlug(p) === host)
  const base = slugify(project.name)
  const sameSlug = siblings.filter((p) => slugify(p.name) === base)
  if (sameSlug.length <= 1) return base
  const idx = sameSlug.indexOf(project)
  return idx <= 0 ? base : `${base}-${idx + 1}`
}

/** Build the full hash path for a project. */
export function projectPath(project, allProjects) {
  return `/${hostSlug(project)}/${projectSlug(project, allProjects)}`
}

/** Navigate to a hash route. */
export function navigateTo(path) {
  const clean = path.replace(/\/+$/, '') || '/'
  location.hash = '#' + clean
}
