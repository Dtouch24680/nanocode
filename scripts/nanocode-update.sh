#!/bin/bash
#
# nanocode-update.sh — daily auto-update for system-mode nanocode.
#
# Compares the installed version (from /usr/lib/nanocode/package.json)
# against the latest GitHub release tag. If they differ, downloads the
# release tarball, runs install.sh inside it, and restarts the router.
#
# Intended to be invoked by nanocode-update.timer (oneshot). Logs go
# to journalctl via the systemd service.
#
# Exit codes:
#   0 — already up to date, or update applied successfully
#   1 — update attempted but failed (network, install, restart)
#
# Disable with: sudo systemctl disable --now nanocode-update.timer

set -euo pipefail

REPO="${NANOCODE_UPDATE_REPO:-victoriacity/nanocode}"
PREFIX="${NANOCODE_PREFIX:-/usr/lib/nanocode}"
SERVICE="${NANOCODE_SERVICE:-nanocode}"

log() { echo "[nanocode-update $(date -Iseconds)] $*"; }
die() { log "ERROR: $*"; exit 1; }

[ "$(id -u)" -eq 0 ] || die "must run as root"

command -v curl >/dev/null || die "curl not found"
command -v tar  >/dev/null || die "tar not found"
command -v node >/dev/null || die "node not found"

# Current installed version, e.g. "1.0.0".
if [ ! -f "$PREFIX/package.json" ]; then
    die "$PREFIX/package.json missing — is nanocode installed?"
fi
installed=$(node -p "require('$PREFIX/package.json').version" 2>/dev/null \
            | tr -d '[:space:]')
[ -n "$installed" ] || die "could not read installed version"

# Latest GitHub release, e.g. tag_name "v1.0.1".
api="https://api.github.com/repos/$REPO/releases/latest"
release_json=$(curl -fsSL --max-time 20 \
                    -H "Accept: application/vnd.github+json" \
                    "$api" 2>/dev/null) || die "GitHub API unreachable ($api)"

latest_tag=$(echo "$release_json" \
             | grep -m1 '"tag_name"' \
             | sed -E 's/.*"tag_name"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/')
[ -n "$latest_tag" ] || die "could not parse latest tag from GitHub response"

# Strip a leading "v" for comparison.
latest="${latest_tag#v}"

if [ "$installed" = "$latest" ]; then
    log "up to date ($installed)"
    exit 0
fi

log "update available: $installed -> $latest"

tarball_url=$(echo "$release_json" \
              | grep -m1 '"tarball_url"' \
              | sed -E 's/.*"tarball_url"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/')
[ -n "$tarball_url" ] || die "no tarball_url in release JSON"

tmp=$(mktemp -d -t nanocode-update.XXXXXX)
trap 'rm -rf "$tmp"' EXIT

log "downloading $tarball_url"
curl -fsSL --max-time 120 -o "$tmp/release.tar.gz" "$tarball_url" \
    || die "download failed"

mkdir "$tmp/src"
tar -xzf "$tmp/release.tar.gz" -C "$tmp/src" \
    || die "tar extraction failed"

# GitHub archives extract into a single top-level directory like
# "victoriacity-nanocode-<short-sha>". Find it.
src_root=$(find "$tmp/src" -maxdepth 1 -mindepth 1 -type d | head -1)
[ -n "$src_root" ] || die "no top-level dir in tarball"
[ -x "$src_root/scripts/install.sh" ] || die "scripts/install.sh missing in tarball"

log "running $src_root/scripts/install.sh"
"$src_root/scripts/install.sh" || die "install.sh failed"

log "restarting $SERVICE"
systemctl restart "$SERVICE" || die "systemctl restart $SERVICE failed"

log "update complete: $installed -> $latest"
