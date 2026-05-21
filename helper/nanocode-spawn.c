/*
 * nanocode-spawn — the only privileged binary in nanocode.
 *
 * Installed as /usr/lib/nanocode/nanocode-spawn, owner root:nanocode,
 * mode 4750 (setuid root, executable by the nanocode group only). The
 * `nanocode` CLI execs this binary; the kernel briefly grants
 * effective-uid 0 so the binary can call setuid() to drop to the
 * invoking user's uid. The binary then execs the per-user worker.
 *
 * Audit checklist:
 *   - argv is ignored; the binary takes no user-controlled input.
 *   - env is constructed from passwd; the caller's environment is dropped.
 *   - The only privileged action is setuid(getuid()); we cannot become
 *     anyone other than the invoking user.
 *   - PR_SET_NO_NEW_PRIVS=1 prevents the worker from regaining setuid.
 *
 * Build:   make -C helper
 * Install: install -o root -g nanocode -m 4750 nanocode-spawn /usr/lib/nanocode/
 */

#define _GNU_SOURCE
#include <err.h>
#include <errno.h>
#include <grp.h>
#include <pwd.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
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

int main(int argc, char **argv) {
    (void)argc;
    (void)argv;

    uid_t uid = getuid();
    if (uid < NANOCODE_MIN_UID) {
        errx(1, "system account (uid %u) not allowed", (unsigned)uid);
    }

    struct passwd *pw = getpwuid(uid);
    if (!pw) errx(1, "no passwd entry for uid %u", (unsigned)uid);

    /* Drop privileges. If the helper is NOT installed setuid (e.g., during
     * development), getuid() == geteuid() and we have nothing to drop —
     * just continue. Production installs use mode 4750 so geteuid()==0
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
