# Nanocode — System Mode Design

System mode lets a single nanocode installation serve every local Linux
user on a host. Each user logs in with their existing Linux account and
gets terminals and file I/O scoped to their own UID. Single-user mode
remains the default; system mode is opt-in via the `NANOCODE_SYSTEM=1`
environment variable.

This doc is the load-bearing reference for implementation. Test specs
live in `server/tests/system-mode/` and `terminal/tests/system-mode/`
under the same branch.

---

## 1. Goals & non-goals

**In scope**
- One nanocode installation per host, serving any number of local accounts.
- Authentication via the user's existing SSH credentials, no passwords sent
  through the web app.
- Per-user isolation: A cannot see B's projects, tabs, files, or terminals.
- PTYs and file I/O execute as the user's own UID/GID; new files are owned
  by them; `$HOME`, `$PATH`, `$SHELL` are correct.
- Tab and file-explorer state survives across devices and page refresh.
- Defense in depth: a compromise of the public-facing Node process must not
  grant access to other users' filesystems or persist as root.

**Out of scope (v1)**
- Multi-host fleets / federated state. Each host has its own users.
- Public exposure beyond a trusted network (no TLS in the router; rely on
  tailnet/LAN/reverse proxy).
- Shared workspaces, ACLs across users, or admin "see all" views.
- OIDC / SAML / external identity providers.
- Linux containers / sub-UIDs / unprivileged user-namespacing.

**Non-goal that's important to call out**
- We do NOT prevent a user from doing harm to *their own* account. If alice
  asks Claude Code to `rm -rf $HOME`, that runs as alice and is alice's
  responsibility. The kernel UID model is our floor.

---

## 2. Threat model

| Attacker | Power | Defense |
|---|---|---|
| Unauthenticated network peer | Reach `:3000` on the LAN/tailnet | Router demands `nano_sid` cookie; missing/invalid → 401/redirect. No content endpoints respond without auth. |
| Authenticated user A | A valid session for uid=alice | Router resolves the session to alice's worker only. Workers serve only their owner's data. Tab broadcasts scoped to {uid, projectId}. |
| RCE in the Node router | Arbitrary code as the `nanocode` service account | Router has no setuid, no `cap_dac_override`, cannot read `/home/*` (ProtectHome=yes), cannot exec arbitrary binaries (ProtectSystem=strict). Worker sockets are 0600 owned by the user, so the router can talk to them only because users explicitly registered. Attacker can ride existing alice/bob sessions to read their files (same scope as a webshell on those accounts) but cannot pivot to other users, become root, or persist. |
| RCE in the setuid C helper | The helper has uid=0 momentarily | The helper is ~150 LOC, no parsing, no I/O — just `getuid → initgroups → setgid → setuid → cap drop → execve`. Audit-by-eye. Caller's real uid is the only target; attacker cannot setuid to anyone else by tampering with arguments. |
| User account on the host (no nanocode access) | uid=mallory in /etc/passwd | mallory can run `nanocode login` and get her own worker. She gains nothing she didn't already have over SSH. |
| Host root compromise | Game over for everything | Out of scope. Nanocode trusts the kernel + filesystem ACLs. |

The Gradio precedent: a single web bug in a process that runs as a normal
user with shell access pivoted into broad host compromise. System mode is
designed so the analogous bug in nanocode-router cannot reach other users'
files at all — the kernel says no before our code does.

---

## 3. Locked decisions

| Decision | Value |
|---|---|
| Auth backend | SSH-key, claim-from-terminal |
| Allowed accounts | Any UID ≥ 1000 in `/etc/passwd` |
| Topology | Single physical host |
| Workspace sharing | None |
| Per-user state location | `$HOME/.nanocode/data.json` (mode 0600) |
| Privilege model | Node never root/setuid; tiny C helper invoked by user CLI |
| TLS | Plain HTTP on trusted network only |
| Mode gating | `NANOCODE_SYSTEM=1` env opt-in; default stays single-user |
| Session lifetime | Rolling 24h cookie; worker idle-evict at 24h |

---

## 4. Architecture

```
                ┌──────────── nanocode-router (User=nanocode) ────────────┐
                │  Express + WS termination, login UI                     │
                │  Session table {sid → {uid, username, workerSock}}      │
                │  Worker registry  {uid → {sock, lastSeen, claimCode}}   │
                │  Proxies every HTTP/WS request to the user's worker     │
                │  Hardened systemd unit (ProtectHome, NoNewPrivileges…)  │
                │  Bind: 0.0.0.0:3000 (plain HTTP, trusted network)       │
                └──────────┬──────────────────────────┬────────────────────┘
                           │ /run/nanocode/             │
                           │   router.sock              │
                           ▼                            ▼
        ┌─ alice's flow (uid=1001) ──────┐  ┌─ bob's flow (uid=1002) ────┐
        │ ssh host                       │  │                            │
        │ $ nanocode login               │  │                            │
        │  exec→ /usr/lib/nanocode/      │  │                            │
        │       nanocode-spawn (4750)    │  │                            │
        │       - getuid()  → 1001        │  │                            │
        │       - initgroups, setgid     │  │                            │
        │       - setuid(1001)           │  │                            │
        │       - drop caps              │  │                            │
        │       - execve worker.js       │  │                            │
        │                                │  │                            │
        │ worker(uid=1001, gid=1001)     │  │ worker(uid=1002)           │
        │  /run/nanocode/u-alice.sock    │  │  /run/nanocode/u-bob.sock  │
        │  0600 alice:alice              │  │  0600 bob:bob              │
        │  - Registers with router       │  │                            │
        │  - Asks router for claim code  │  │                            │
        │  - Spawns PTYs (node-pty)      │  │                            │
        │  - File API                    │  │                            │
        └──────────────┬─────────────────┘  └────────────────────────────┘
                       │
                       ▼
              $HOME/.nanocode/data.json
              (projects, tabs, settings)
```

---

## 5. Auth flow

```
1. alice → http://host:3000/
   - No cookie → router renders /login
   - /login page: "SSH to <host> and run: nanocode login"

2. alice (already SSH'd) runs `nanocode login`
   - The thin CLI execs the setuid helper
   - Helper resolves real uid via getuid()
   - Rejects if uid < 1000
   - Resolves pw entry via getpwuid()
   - initgroups(name, gid)
   - setgid(gid); setuid(uid)
   - prctl(PR_SET_NO_NEW_PRIVS, 1)
   - environ pruned to {HOME, USER, SHELL, LOGNAME, PATH}
   - execve("/usr/lib/nanocode/worker.js", ...)

3. Worker boots as alice
   - Creates /run/nanocode/u-alice.sock 0600 alice:alice
   - Dials /run/nanocode/router.sock
   - Sends {type: "register", uid: 1001}
     - Router reads SO_PEERCRED, validates uid matches the claim
   - Sends {type: "claim:request"}
     - Router mints code XYZA-BCDE with 60s TTL, returns it
   - Worker prints "Enter XYZA-BCDE in the nanocode login page (60s)"
   - CLI exits but worker stays alive

4. alice types XYZA-BCDE on /login
   - Router POST /login validates code → mints 32-byte session id
   - Server stores {sid → {uid: 1001, username: "alice", workerSock}}
   - Sets cookie: nano_sid=...; HttpOnly; Secure(if proxy); SameSite=Strict
   - 302 to /

5. Every subsequent request
   - HTTP: cookie middleware → resolves sid → worker sock → http-proxy.web()
   - WS: upgrade handler reads cookie → connects to worker WS → duplex pipe

6. Worker idle eviction
   - 24h with zero active client connections → worker exits cleanly
   - Router clears registry entry; next request from alice → 401 → re-login
```

Notes:
- Claim codes are single-use. Once consumed, the code is invalidated even
  if the TTL hasn't expired.
- A second `nanocode login` while a worker is already running re-uses the
  existing worker and mints a fresh claim code. No second worker spawned.
- `nanocode logout` (run from any device) invalidates the user's sessions
  and is broadcast to all active clients via the tab WS channel.

---

## 6. Filesystem & process layout

```
/usr/lib/nanocode/
  nanocode-spawn         # 4750 root:nanocode — setuid helper (~150 LOC C)
  router.js              # Node entrypoint for the dispatcher
  worker.js              # Node entrypoint for per-user workers
  public/                # Static assets (akari theme)
  vendor/                # marked, highlight.js, DOMPurify, xterm

/usr/local/bin/
  nanocode               # User-facing CLI (~80 LOC)
                         # Subcommands: login | logout | status

/etc/systemd/system/
  nanocode.service       # User=nanocode, hardened (see §8)

/run/nanocode/           # 0750 nanocode:nanocode, tmpfs via RuntimeDirectory=
  router.sock            # 0666 (peer-cred enforced)
  u-<uid>.sock           # 0600 <user>:<user>

$HOME/.nanocode/         # Per-user, created by worker on first use
  data.json              # projects + tabs + settings (0600 <user>:<user>)
```

Group setup at install time:
```
groupadd --system nanocode
useradd --system --gid nanocode --no-create-home --shell /usr/sbin/nologin nanocode
install -d -m 0750 -o nanocode -g nanocode /var/lib/nanocode
```

---

## 7. Router ↔ worker IPC

JSONL frames over the worker's Unix socket. The router opens one
persistent connection per worker for control + HTTP, and one ephemeral
connection per browser WebSocket.

### Control / HTTP channel

| Message | Direction | Body |
|---|---|---|
| `register` | worker → router | `{type, uid}` |
| `register:ok` | router → worker | `{type}` |
| `claim:request` | worker → router | `{type}` |
| `claim:code` | router → worker | `{type, code, expiresAt}` |
| `claim:invalidate` | router → worker | `{type, code}` (e.g., consumed elsewhere) |
| `http` | router → worker | `{type, reqId, method, path, headers, body?}` |
| `http:res` | worker → router | `{type, reqId, status, headers}` followed by stream of `{type:'http:chunk', reqId, data}` and finally `{type:'http:end', reqId}` |
| `ping` / `pong` | both | `{type, id}` |
| `shutdown` | router → worker | `{type, reason}` |

### WebSocket channel

The router opens a fresh worker connection for each browser WS. The
browser ↔ router WS frames are forwarded verbatim. The worker treats its
end of the socket like any WS server. No multiplexing within a single
worker connection.

### Framing

JSONL: one JSON object per line, terminated by `\n`. Bodies for HTTP
proxying are split: headers in one frame, body chunks in subsequent
frames, an `http:end` frame to terminate. This keeps the framer trivial
and avoids unbounded-buffer attacks.

### Backpressure

Both directions honor the writable stream's `.write()` boolean and pause
the source. The worker's HTTP handler is a thin wrapper around the
existing Express `app(req, res)` callable, fed a synthesized `IncomingMessage`.

---

## 8. systemd unit

```ini
[Unit]
Description=Nanocode multi-user dispatcher
After=network.target

[Service]
Type=simple
User=nanocode
Group=nanocode
RuntimeDirectory=nanocode
RuntimeDirectoryMode=0750
ExecStart=/usr/bin/node /usr/lib/nanocode/router.js
Environment=NANOCODE_SYSTEM=1
Environment=HOST=0.0.0.0
Environment=PORT=3000
Restart=on-failure
RestartSec=2s

# Hardening
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelModules=yes
ProtectKernelLogs=yes
ProtectKernelTunables=yes
ProtectControlGroups=yes
ProtectClock=yes
ProtectHostname=yes
ProtectProc=invisible
LockPersonality=yes
MemoryDenyWriteExecute=yes
RestrictRealtime=yes
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
RestrictNamespaces=yes
SystemCallFilter=@system-service
SystemCallErrorNumber=EPERM
CapabilityBoundingSet=
AmbientCapabilities=
UMask=0077

# The router does NOT need to read /home — workers do. ProtectHome=yes
# would normally also hide /run/user/<uid> from the router; explicitly
# bind-mount /run/nanocode through PrivateTmp/PrivateDevices.

[Install]
WantedBy=multi-user.target
```

Workers are launched outside this unit (by users via the setuid helper)
and inherit the kernel's process tree as `<user>:nanocode-worker`. They
do *not* run under the same systemd unit; their hardening comes from the
UID drop plus the helper-applied `PR_SET_NO_NEW_PRIVS`.

---

## 9. Setuid helper

The complete privileged surface, ~30 lines after declarations:

```c
#include <pwd.h>
#include <grp.h>
#include <sys/prctl.h>
#include <unistd.h>
#include <stdlib.h>
#include <string.h>
#include <err.h>

#define WORKER "/usr/lib/nanocode/worker.js"
#define NODE   "/usr/bin/node"

int main(void) {
    uid_t uid = getuid();
    if (uid < 1000) errx(1, "system account not allowed");
    struct passwd *pw = getpwuid(uid);
    if (!pw) errx(1, "no passwd entry");
    if (initgroups(pw->pw_name, pw->pw_gid)) err(1, "initgroups");
    if (setgid(pw->pw_gid)) err(1, "setgid");
    if (setuid(uid)) err(1, "setuid");
    if (geteuid() == 0 || getuid() == 0) errx(1, "uid drop failed");
    if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0)) err(1, "no_new_privs");

    char *clean[] = {
        strdup_or_die("HOME=", pw->pw_dir),
        strdup_or_die("USER=", pw->pw_name),
        strdup_or_die("LOGNAME=", pw->pw_name),
        strdup_or_die("SHELL=", pw->pw_shell),
        "PATH=/usr/local/bin:/usr/bin:/bin",
        NULL
    };
    execve(NODE, (char *[]){NODE, WORKER, NULL}, clean);
    err(1, "execve");
}
```

**Audit checklist**
- No argv passed through unmodified.
- No env passed through; constructed from `passwd` only.
- No `system()`, no shell.
- No file I/O.
- No parsing of untrusted input.
- The single privileged operation is `setuid(uid)` where `uid` came from
  the kernel via `getuid()` — there is no path by which the caller can
  influence which uid the helper becomes.

---

## 10. Per-user data scoping

The worker owns the entire data path. The router never opens any file
under `/home`.

Single-user mode today writes to `data/nanocode.json` at the project's
working directory. In system mode the worker writes to
`$HOME/.nanocode/data.json`. Schema is unchanged:

```jsonc
{
  "projects": [...],
  "tabs": { "<projectId>": [{ "id", "label", "createdAt" }] },
  "settings": {}
}
```

The router holds an in-memory mirror of `{username → workerSock}` only.
Project/tab state lives in the worker process and the user's data file;
the router never persists anything about user content.

### Tab broadcast scope

The `/ws/tabs` subscriber map (today: `Map<projectId, Set<WS>>`) becomes
keyed by `{uid, projectId}`. A subscriber claiming to be uid=1001 must
match the session cookie's uid; mismatches close the WS with code 1008.

---

## 11. Migration from single-user mode

The same `router.js` entrypoint serves both modes; the gate is the
`NANOCODE_SYSTEM` env var.

| Behavior | Single-user (default) | System mode (`NANOCODE_SYSTEM=1`) |
|---|---|---|
| Auth | None | Cookie + claim-from-terminal |
| File API | Handled in-process | Proxied to user worker |
| PTY spawn | In-process node-pty | In user worker |
| Data location | `./data/nanocode.json` | `$HOME/.nanocode/data.json` |
| Tab broadcast scope | per project | per (uid, project) |
| Worker registry | n/a | active |
| Setuid helper installed | optional | required |
| HOST default | `0.0.0.0` | `0.0.0.0` (LAN/tailnet only) |

Worker code is the same module that handles the routes today; it just
runs in its own process (single-user) or one process per logged-in user
(system mode). Single-user mode keeps the worker in-process to avoid
penalizing the dev quickstart.

---

## 12. Phasing

| Phase | Scope | Effort |
|---|---|---|
| P1 | Refactor existing routes into a `worker` module that listens on a Unix socket. Single-user mode wires the router straight to it via in-process call. No behavior change. | 2d |
| P2 | C setuid helper. Makefile under `helper/`, install target. Unit test that getuid drop is correct and execve happens. | 1d |
| P3 | `nanocode` CLI (~80 LOC). `login` invokes helper; `logout` clears server-side session; `status` shows current worker state. | 1d |
| P4 | Router auth + session table + worker registry. Cookie middleware. `/login` POST validates claim code. `/logout`. | 2d |
| P5 | Router-to-worker proxy (HTTP + WS). JSONL IPC, request framer, WS duplex pipe. | 2d |
| P6 | Per-user `$HOME/.nanocode/data.json` + scoped tab broadcast. | 1d |
| P7 | Login UI: claim-code input, 60s countdown, error states. Akari styling. | 1d |
| P8 | systemd unit + install script. `install.sh` lays files, creates `nanocode` user+group, runs `systemctl daemon-reload`. | 1d |
| P9 | Hardening pass — verify ProtectHome works, fuzz IPC, fill the threat-model checklist. | 2d |

Total: ~12–14 focused dev-days. P1 lands without enabling system mode
and unblocks every later phase.

---

## 13. Observability & operations

- `journalctl -u nanocode` for the router; worker logs go to
  `~/.nanocode/log/worker.log` (rotated at 5 MB).
- `nanocode status` (CLI) prints the user's worker state + active
  session count.
- A health endpoint `/api/system/health` (single-user-mode-only) is
  *removed* from system mode and replaced with `/api/auth/whoami`
  (returns `{username, uid}` or 401).
- `/etc/cron.daily/nanocode-cleanup` reaps orphan sockets in
  `/run/nanocode/` whose worker PID is dead.

---

## 14. Test plan

Detailed test specifications live alongside the code. Summary index:

**Unit suites**
- `server/tests/system-mode/session.test.js` — token mint/validate/expire,
  rolling refresh, single-use enforcement, revocation.
- `server/tests/system-mode/claim.test.js` — code generation entropy +
  format, 60s TTL, single-use semantics, uid binding.
- `server/tests/system-mode/worker-registry.test.js` — register/unregister,
  peer-cred validation, duplicate-uid rejection, idle eviction.
- `server/tests/system-mode/ipc-protocol.test.js` — JSONL framer, chunked
  body assembly, backpressure handoff, malformed-frame rejection.
- `server/tests/system-mode/data-store.test.js` — `$HOME/.nanocode/data.json`
  read/write, mode 0600, missing-file initialization.
- `server/tests/system-mode/auth-middleware.test.js` — cookie parse,
  redirect-to-login on missing cookie, 401 on invalid sid, WS upgrade
  cookie validation.

**E2E suites**
- `terminal/tests/system-mode/login-flow.test.js` — happy path, expired
  code, invalid code, second-device parallel login.
- `terminal/tests/system-mode/two-user-isolation.test.js` — alice's
  projects/tabs/files invisible to bob via any endpoint.
- `terminal/tests/system-mode/tab-broadcast-scope.test.js` — bob's
  `/ws/tabs` subscription receives no updates for alice's project.
- `terminal/tests/system-mode/worker-lifecycle.test.js` — first request
  spawns worker, idle reaper exits after timeout, next request re-prompts
  login.
- `terminal/tests/system-mode/hardening-smoke.test.js` — under the
  hardened unit, the router process cannot `open("/etc/shadow")` or
  `open("/home/<u>/anything")`. Skipped if not running under systemd
  with the hardened unit applied.

Tests use Node's built-in `node:test` runner (same as the existing
suites). Each suite imports its module under test inside a `before()`
hook with a try/catch — if the implementation hasn't landed yet, the
suite skips cleanly rather than crashing the runner.

A test fixture under `server/tests/system-mode/fixtures/` provides:
- `mock-pwd.js` — synthetic `passwd` entries for fake uids.
- `mock-helper.js` — JS stand-in for the setuid C helper, sufficient to
  drive the worker registration handshake.
- `with-router.js` — spins up a router on an ephemeral port + tmpdir for
  socket files; returns teardown.
- `with-worker.js` — spins up a worker process under the test runner's
  own uid, registers with a given router instance.

---

## 15. Open questions for future work

1. **`nanocode logout` from another device** — server-side session
   invalidation is straightforward; the question is whether to also
   broadcast a logout event so other devices clear their cookies
   automatically. Probably yes via a `/ws/tabs` `auth:logout` push.
2. **Long-running PTYs vs. worker idle eviction.** A 24h-idle bash with
   no clients should be killed, but a 24h-idle `claude code --stream`
   that's mid-task should not. Workers need a "has-foreground-work"
   probe; punted to a follow-up.
3. **Migration of single-user data.** A user who's been running
   nanocode personally and now wants system mode should ideally pick up
   their existing `data.json`. Provide `nanocode migrate
   <path/to/data.json>` to import into `$HOME/.nanocode/data.json`.

---

## Appendix A — non-decisions worth recording

- We considered running the router as root and dropping privileges on a
  per-request fork (openssh model). Rejected: keeping root anywhere in
  the Node process expands the attack surface against the Gradio-class
  precedent.
- We considered an admin / superuser role with cross-account visibility.
  Rejected: no concrete need, and any admin endpoint is a high-value
  target. Operators have shell access; that's enough.
- We considered hosting `data.json` in `/var/lib/nanocode/users/<u>/`.
  Rejected: `$HOME` ties data to backups + makes the user the
  unambiguous owner.
- We considered native TLS in the router. Rejected for v1: cert
  lifecycle in a Node process is friction without payoff if the deploy
  is tailnet-only or behind a reverse proxy.
