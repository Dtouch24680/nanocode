#!/usr/bin/env bash
set -e

REPO="https://github.com/victoriacity/nanocode.git"
DIR="nanocode"
PORT="${PORT:-3000}"

echo "=== Nanocode Installer ==="
echo

# Check for Node.js
if ! command -v node &>/dev/null; then
  echo "Node.js not found. Installing via NodeSource..."
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

NODE_VER=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VER" -lt 18 ]; then
  echo "Error: Node.js 18+ required (found $(node -v))."
  exit 1
fi
echo "Node.js $(node -v) OK"

# Ensure build tools for native modules
if ! command -v make &>/dev/null; then
  echo "Installing build tools..."
  sudo apt-get install -y build-essential
fi

# Clone or update
if [ -d "$DIR" ]; then
  echo "Updating existing install..."
  cd "$DIR"
  git pull --ff-only
else
  echo "Cloning repository..."
  git clone "$REPO" "$DIR"
  cd "$DIR"
fi

# Install dependencies
echo "Installing dependencies..."
npm install

echo
echo "=== Ready ==="
echo "Run:  cd $DIR && npm run dev"
echo "Open: http://localhost:$PORT"
echo
read -rp "Start now? [Y/n] " answer
if [[ -z "$answer" || "$answer" =~ ^[Yy] ]]; then
  npm run dev
fi
