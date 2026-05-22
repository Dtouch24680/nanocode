/*
 * nanocode-spawn — the only privileged binary in nanocode.
 *
 * Installed as /usr/lib/nanocode/nanocode-spawn, owner root:root,
 * mode 4755 (setuid root, world-executable). Any local user can run
 * it; the kernel grants effective-uid 0 briefly so the binary can:
 *   (a) create /run/nanocode/u<uid>/ owned by user:nanocode mode 02750,
 *       so files the worker drops inside inherit group `nanocode` via
 *       the setgid bit and the router (running as `nanocode`) can
 *       connect to them, without requiring users to be in any group;
 *   (b) call setuid() to drop to the invoking user's uid and exec the
 *       worker.
 *
 * Audit checklist:
 *   - argv is ignored; the binary takes no user-controlled input.
 *   - env is constructed from passwd; the caller's environment is dropped.
 *   - The only privileged actions are mkdir/chown/chmod of a path
 *     deterministically derived from getuid(), then setuid(getuid()).
 *   - We never become anyone other than the invoking user.
 *   - PR_SET_NO_NEW_PRIVS=1 prevents the worker from regaining setuid.
 *
 * Build:   make -C helper
 * Install: install -o root -g root -m 4755 nanocode-spawn /usr/lib/nanocode/
 */

#define _GNU_SOURCE
#include <err.h>
#include <errno.h>
#include <grp.h>
#include <pwd.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>

/* These paths are baked at compile time so the helper has no
 * runtime path-resolution surface. Override at build with:
 *   make NANOCODE_NODE=/path/to/node NANOCODE_WORKER=/path/to/worker/index.js */
#ifndef NANOCODE_NODE
#define NANOCODE_NODE "/usr/bin/node"
#endif
#ifndef NANOCODE_WORKER
#define NANOCODE_WORKER "/usr/lib/nanocode/worker/index.js"
#endif

#ifndef NANOCODE_MIN_UID
#define NANOCODE_MIN_UID 1000
#endif

#ifndef NANOCODE_RUNTIME_DIR
#define NANOCODE_RUNTIME_DIR "/run/nanocode"
#endif

#ifndef NANOCODE_SERVICE_GROUP
#define NANOCODE_SERVICE_GROUP "nanocode"
#endif

static char *envstr(const char *key, const char *value) {
    size_t klen = strlen(key);
    size_t vlen = strlen(value);
    char *buf = malloc(klen + vlen + 2);
    if (!buf) err(1, "malloc");
    memcpy(buf, key, klen);
    buf[klen] = '=';
    memcpy(buf + klen + 1, value, vlen);
    buf[klen + 1 + vlen] = '\0';
    return buf;
}

/*
 * Ensure /run/nanocode/u<uid>/ exists, owned by <user>:nanocode,
 * mode 02750. The setgid bit means any file the worker drops inside
 * inherits group `nanocode`, so the router (running as nanocode) can
 * connect to the worker's Unix socket — without the user needing to
 * be a member of any group.
 */
static void ensure_runtime_subdir(uid_t uid, gid_t user_gid) {
    char path[128];
    int n = snprintf(path, sizeof(path), "%s/u%u", NANOCODE_RUNTIME_DIR, (unsigned)uid);
    if (n <= 0 || (size_t)n >= sizeof(path)) errx(1, "runtime path too long");

    /* mkdir is idempotent — ignore EEXIST. */
    if (mkdir(path, 0700) != 0 && errno != EEXIST) {
        err(1, "mkdir %s", path);
    }

    /* Resolve nanocode service group at runtime. If absent, fall back
     * to the user's own primary group (degraded mode — the router won't
     * be able to connect, but the worker still boots for diagnostics). */
    struct group *gr = getgrnam(NANOCODE_SERVICE_GROUP);
    gid_t svc_gid = gr ? gr->gr_gid : user_gid;

    if (chown(path, uid, svc_gid) != 0) err(1, "chown %s", path);
    /* 02750 = setgid + user rwx + group rx. Files created inside
     * inherit group=svc_gid via the setgid bit. */
    if (chmod(path, 02750) != 0) err(1, "chmod %s", path);
}

int main(int argc, char **argv) {
    (void)argc;
    (void)argv;

    uid_t uid = getuid();
    if (uid < NANOCODE_MIN_UID) {
        errx(1, "system account (uid %u) not allowed", (unsigned)uid);
    }

    struct passwd *pw = getpwuid(uid);
    if (!pw) errx(1, "no passwd entry for uid %u", (unsigned)uid);

    /* While we still hold euid=0, set up the per-uid runtime subdir. */
    if (geteuid() == 0) {
        ensure_runtime_subdir(uid, pw->pw_gid);
    }

    /* Drop privileges. If the helper is NOT installed setuid (e.g., during
     * development), getuid() == geteuid() and we have nothing to drop —
     * just continue. Production installs use mode 4755 so geteuid()==0
     * here and the drop is the load-bearing step. */
    if (geteuid() == 0) {
        if (initgroups(pw->pw_name, pw->pw_gid) != 0) err(1, "initgroups");
        if (setgid(pw->pw_gid) != 0) err(1, "setgid");
        if (setuid(uid) != 0) err(1, "setuid");
        if (geteuid() == 0 || getuid() == 0) errx(1, "uid drop failed");
    } else if (geteuid() != uid) {
        errx(1, "unexpected euid %u (expected %u)", (unsigned)geteuid(), (unsigned)uid);
    }

    if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) {
        err(1, "PR_SET_NO_NEW_PRIVS");
    }

    /* Construct a clean environment from passwd. The caller's environ
     * is intentionally dropped so the worker boots from a known base. */
    char *clean_env[] = {
        envstr("HOME", pw->pw_dir),
        envstr("USER", pw->pw_name),
        envstr("LOGNAME", pw->pw_name),
        envstr("SHELL", pw->pw_shell),
        "PATH=/usr/local/bin:/usr/bin:/bin",
        NULL,
    };

    /* The worker reads NANOCODE_WORKER_SOCK / NANOCODE_ROUTER_SOCK from
     * a small init file the CLI placed under $HOME/.nanocode/run/.
     * The helper itself does not see or pass those values. */

    char *node_argv[] = {
        (char *)NANOCODE_NODE,
        (char *)NANOCODE_WORKER,
        NULL,
    };
    execve(NANOCODE_NODE, node_argv, clean_env);
    err(1, "execve %s", NANOCODE_NODE);
}
