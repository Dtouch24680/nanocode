/**
 * Cookie-based auth middleware for the router.
 *
 * On hit: req.user = { uid, username, workerSock } and the session is
 * rolled forward.
 * On miss: HTML clients are redirected to /login; API clients get
 * 401 JSON. (Detection: Accept: text/html → HTML; Accept: application/
 * json OR path starts with /api/ → API.)
 *
 * Bypass list: requests whose path is in `bypass` are passed through
 * without auth (the caller is responsible for serving /login, /logout,
 * the login bundle, etc.).
 */

const COOKIE_NAME = 'nano_sid'

/** Tiny cookie parser — we only need one named cookie. */
export function parseCookie(header, name = COOKIE_NAME) {
  if (!header) return null
  const parts = String(header).split(';')
  for (const part of parts) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    const k = part.slice(0, eq).trim()
    if (k === name) return part.slice(eq + 1).trim()
  }
  return null
}

function wantsJson(req) {
  if (req.url && req.url.startsWith('/api/')) return true
  const accept = (req.headers['accept'] || '').toLowerCase()
  return accept.includes('application/json') && !accept.includes('text/html')
}

export function createAuthMiddleware({
  sessionStore,
  loginPath = '/login',
  bypass = ['/login', '/logout', '/api/auth/whoami-noauth'],
} = {}) {
  if (!sessionStore) throw new Error('createAuthMiddleware: sessionStore required')
  const bypassSet = new Set(bypass)

  return function authMiddleware(req, res, next) {
    // Path bypass — /login etc.
    const urlPath = (req.url || '').split('?')[0]
    if (bypassSet.has(urlPath)) return next()
    // Static assets — let the static middleware below handle them
    // (only protect URLs that look like content). The router can mount
    // this middleware AFTER express.static if it wants to bypass static.

    const sid = parseCookie(req.headers['cookie'])
    if (!sid) return reject(req, res, loginPath)

    const session = sessionStore.get(sid)
    if (!session) return reject(req, res, loginPath)

    sessionStore.touch(sid)
    req.user = { uid: session.uid, username: session.username, workerSock: session.workerSock }
    req.sid = sid
    next()
  }
}

function reject(req, res, loginPath) {
  if (wantsJson(req)) {
    res.statusCode = 401
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ error: 'unauthorized' }))
    return
  }
  // HTML: 302 to /login
  res.statusCode = 302
  res.setHeader('location', loginPath)
  res.end()
}

/** WS upgrade auth — returns the user info or null. */
export function authenticateWsUpgrade(req, sessionStore) {
  const sid = parseCookie(req.headers['cookie'])
  if (!sid) return null
  const session = sessionStore.get(sid)
  if (!session) return null
  return { uid: session.uid, username: session.username, workerSock: session.workerSock }
}
