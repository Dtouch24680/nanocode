#!/bin/bash
#
# install.sh — system-mode install for nanocode.
#
# Lays files under /usr/lib/nanocode/, /usr/local/bin/, /etc/systemd/system/.
# Creates the `nanocode` user + group. Builds and installs the setuid helper.
#
# Re-run-safe: existing files are overwritten in place; existing systemd
# unit is reloaded.

set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
    echo "install.sh: must run as root" >&2
    exit 1
fi

SRC_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PREFIX="/usr/lib/nanocode"
BIN_DIR="/usr/local/bin"
UNIT_DIR="/etc/systemd/system"
DOC_DIR="/usr/share/doc/nanocode"

NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
    echo "install.sh: node not found in PATH — install Node.js (>=18) first" >&2
    exit 1
fi

echo "==> Creating nanocode user + group"
if ! getent group nanocode >/dev/null; then
    groupadd --system nanocode
fi
if ! getent passwd nanocode >/dev/null; then
    useradd --system --gid nanocode --no-create-home \
            --home-dir /nonexistent --shell /usr/sbin/nologin nanocode
fi

echo "==> Adding interactive users (uid >= 1000) to the nanocode group"
while IFS=: read -r name _ uid _; do
    if [ "$uid" -ge 1000 ] && [ "$uid" -lt 60000 ]; then
        gpasswd -a "$name" nanocode >/dev/null || true
    fi
done < /etc/passwd

echo "==> Installing application to $PREFIX"
install -d -m 0755 "$PREFIX"
install -d -m 0755 "$PREFIX/server" "$PREFIX/server/auth" "$PREFIX/server/ipc" "$PREFIX/server/middleware"
install -d -m 0755 "$PREFIX/worker"
install -d -m 0755 "$PREFIX/terminal"
install -d -m 0755 "$PREFIX/public"

# Copy server, worker, terminal, public trees
cp -r "$SRC_DIR/server/." "$PREFIX/server/"
cp -r "$SRC_DIR/worker/." "$PREFIX/worker/"
cp -r "$SRC_DIR/terminal/." "$PREFIX/terminal/"
cp -r "$SRC_DIR/public/." "$PREFIX/public/"
cp "$SRC_DIR/package.json" "$PREFIX/"
cp "$SRC_DIR/package-lock.json" "$PREFIX/" 2>/dev/null || true

echo "==> Installing dependencies"
(cd "$PREFIX" && npm install --omit=dev --no-audit --no-fund)

echo "==> Building setuid helper"
make -C "$SRC_DIR/helper" clean
make -C "$SRC_DIR/helper" \
    NANOCODE_NODE="$NODE_BIN" \
    NANOCODE_WORKER="$PREFIX/worker/index.js"
install -m 4750 -o root -g nanocode \
    "$SRC_DIR/helper/nanocode-spawn" "$PREFIX/nanocode-spawn"

echo "==> Installing CLI"
install -m 0755 "$SRC_DIR/bin/nanocode" "$BIN_DIR/nanocode"

echo "==> Installing systemd unit"
install -m 0644 "$SRC_DIR/scripts/nanocode.service" "$UNIT_DIR/nanocode.service"
systemctl daemon-reload

echo "==> Installing docs"
install -d -m 0755 "$DOC_DIR"
install -m 0644 "$SRC_DIR/docs/system-mode-design.md" "$DOC_DIR/"

echo "==> Done. Enable + start with:"
echo "    sudo systemctl enable --now nanocode"
echo
echo "    Then users can run:  nanocode login"
echo "    Web access:          http://<host>:3000"
