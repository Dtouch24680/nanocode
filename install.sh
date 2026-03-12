#!/usr/bin/env bash
set -e

PORT="${PORT:-3000}"

# Ensure we're in the repo root
if [ ! -f "package.json" ] || ! grep -q '"nanocode"' package.json 2>/dev/null; then
  echo "Error: Run this script from the nanocode repo root."
  exit 1
fi

echo "=== Nanocode Installer ==="
echo

# Detect platform
OS="$(uname -s)"
case "$OS" in
  Linux*)   PLATFORM="linux" ;;
  Darwin*)  PLATFORM="mac" ;;
  MINGW*|MSYS*|CYGWIN*) PLATFORM="windows" ;;
  *)        PLATFORM="unknown" ;;
esac
echo "Platform: $PLATFORM"

# Check for Node.js
if ! command -v node &>/dev/null; then
  if [ "$PLATFORM" = "windows" ]; then
    echo "Node.js not found."
    echo "Install from https://nodejs.org or run:  winget install OpenJS.NodeJS.LTS"
    echo "Then restart Git Bash and re-run this script."
    exit 1
  fi
  echo "Node.js not found. Installing..."
  if [ "$PLATFORM" = "mac" ]; then
    if command -v brew &>/dev/null; then
      brew install node@20
    else
      echo "Error: Install Homebrew (https://brew.sh) or Node.js 20+ manually and re-run."
      exit 1
    fi
  else
    if command -v curl &>/dev/null; then
      curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    elif command -v wget &>/dev/null; then
      wget -qO- https://deb.nodesource.com/setup_20.x | sudo -E bash -
    else
      echo "Error: curl or wget required. Install Node.js 20+ manually and re-run."
      exit 1
    fi
    sudo apt-get install -y nodejs
  fi
fi

NODE_VER=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VER" -lt 18 ]; then
  echo "Error: Node.js 18+ required (found $(node -v))."
  exit 1
fi
echo "Node.js $(node -v) OK"

# Ensure build tools for native modules
if [ "$PLATFORM" = "linux" ] && ! command -v make &>/dev/null; then
  echo "Installing build tools..."
  sudo apt-get install -y build-essential
elif [ "$PLATFORM" = "windows" ]; then
  if ! command -v cl &>/dev/null 2>&1; then
    VSWHERE="/c/Program Files (x86)/Microsoft Visual Studio/Installer/vswhere.exe"
    HAS_VS=false
    if [ -f "$VSWHERE" ]; then
      VS_PATH=$("$VSWHERE" -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath 2>/dev/null || true)
      [ -n "$VS_PATH" ] && HAS_VS=true
    fi
    if [ "$HAS_VS" = false ]; then
      echo ""
      echo "WARNING: Visual Studio Build Tools not found."
      echo "Native module node-pty requires C++ build tools."
      echo ""
      echo "Install from PowerShell (admin):"
      echo "  winget install Microsoft.VisualStudio.2022.BuildTools --override \"--wait --passive --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended\""
      echo ""
      read -rp "Continue anyway? [y/N] " cont
      if [[ ! "$cont" =~ ^[Yy] ]]; then
        exit 1
      fi
    fi
  fi
fi

# Install dependencies
echo "Installing dependencies..."
npm install

echo
echo "=== Ready ==="
echo "Run:  npm run dev"
echo "Open: http://localhost:$PORT"
echo
read -rp "Start now? [Y/n] " answer
if [[ -z "$answer" || "$answer" =~ ^[Yy] ]]; then
  npm run dev
fi
