#!/bin/bash
set -e

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

info()    { echo -e "${YELLOW}[INFO] $1${NC}"; }
success() { echo -e "${GREEN}[OK] $1${NC}"; }
error()   { echo -e "${RED}[ERROR] $1${NC}"; exit 1; }

# --- Detect OS and architecture ---
OS=$(uname -s)
ARCH=$(uname -m)

case "$OS" in
  Linux)  OS_NAME="linux" ;;
  Darwin) OS_NAME="macos" ;;
  *)      error "Unsupported OS: $OS" ;;
esac

case "$ARCH" in
  x86_64)          ARCH_NAME="x64" ;;
  aarch64|arm64)   ARCH_NAME="arm64" ;;
  armv7l)          ARCH_NAME="armv7l" ;;
  *)               error "Unsupported architecture: $ARCH" ;;
esac

# Map to actual release asset names:
#   macOS         -> mudslide-macos.tgz  (tgz, arch-independent)
#   Linux x64     -> mudslide-linuxstatic-x64
#   Linux arm64   -> mudslide-linuxstatic-arm64
if [ "$OS_NAME" = "macos" ]; then
  ASSET_NAME="mudslide-macos.tgz"
  IS_ARCHIVE=true
else
  ASSET_NAME="mudslide-linuxstatic-${ARCH_NAME}"
  IS_ARCHIVE=false
fi

info "Detected: $OS_NAME / $ARCH_NAME (asset: $ASSET_NAME)"

# --- Install Node.js + npm ---
if command -v node &>/dev/null && command -v npm &>/dev/null; then
  success "Node.js $(node -v) and npm $(npm -v) already installed"
else
  info "Installing Node.js..."
  if [ "$OS_NAME" = "macos" ]; then
    if command -v brew &>/dev/null; then
      brew install node
    else
      error "Homebrew not found. Install it from https://brew.sh then re-run."
    fi
  else
    # Linux: use NodeSource installer for LTS
    curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash - 2>/dev/null || \
      curl -fsSL https://rpm.nodesource.com/setup_lts.x | sudo bash - 2>/dev/null || \
      error "Could not install Node.js. Install manually from https://nodejs.org"
    sudo apt-get install -y nodejs 2>/dev/null || sudo yum install -y nodejs 2>/dev/null || true
  fi
  success "Node.js $(node -v) installed"
fi

# --- Install npm dependencies ---
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
info "Installing npm dependencies..."
cd "$SCRIPT_DIR"
npm install
success "npm dependencies installed"

# --- Install mudslide globally ---
if command -v mudslide &>/dev/null; then
  success "mudslide already installed at $(which mudslide)"
else
  info "Fetching latest mudslide release..."

  RELEASE_URL="https://api.github.com/repos/robvanderleek/mudslide/releases/latest"
  LATEST_JSON=$(curl -fsSL "$RELEASE_URL")

  DOWNLOAD_URL=$(echo "$LATEST_JSON" | grep -o '"browser_download_url": *"[^"]*'"$ASSET_NAME"'"' | grep -o 'https://[^"]*' | head -1)

  if [ -z "$DOWNLOAD_URL" ]; then
    error "No mudslide asset '$ASSET_NAME' found. Check https://github.com/robvanderleek/mudslide/releases"
  fi

  info "Downloading $DOWNLOAD_URL..."
  TMPDIR_MUDSLIDE=$(mktemp -d)

  if [ "$IS_ARCHIVE" = true ]; then
    curl -fsSL "$DOWNLOAD_URL" -o "$TMPDIR_MUDSLIDE/mudslide.tgz"
    tar -xzf "$TMPDIR_MUDSLIDE/mudslide.tgz" -C "$TMPDIR_MUDSLIDE"
    BINARY=$(find "$TMPDIR_MUDSLIDE" -type f -name "mudslide" | head -1)
    [ -z "$BINARY" ] && error "Could not find mudslide binary inside archive"
    chmod +x "$BINARY"
    sudo mv "$BINARY" /usr/local/bin/mudslide
  else
    curl -fsSL "$DOWNLOAD_URL" -o "$TMPDIR_MUDSLIDE/mudslide"
    chmod +x "$TMPDIR_MUDSLIDE/mudslide"
    sudo mv "$TMPDIR_MUDSLIDE/mudslide" /usr/local/bin/mudslide
  fi

  rm -rf "$TMPDIR_MUDSLIDE"
  success "mudslide installed to /usr/local/bin/mudslide"
fi

# Verify
mudslide --version 2>/dev/null && success "mudslide $(mudslide --version) ready" || info "mudslide installed (version check not available)"

# --- Install proxychains4 (needed for residential proxy support) ---
if command -v proxychains4 &>/dev/null; then
  success "proxychains4 already installed"
else
  info "Installing proxychains4 (required for residential proxy support)..."
  if [ "$OS_NAME" = "macos" ]; then
    if command -v brew &>/dev/null; then
      brew install proxychains-ng && success "proxychains4 installed" \
        || info "proxychains4 install failed — proxy support will be disabled until installed"
    else
      info "Homebrew not found — skipping proxychains4 (optional, install manually with 'brew install proxychains-ng')"
    fi
  else
    sudo apt-get install -y proxychains4 2>/dev/null \
      || sudo yum install -y proxychains-ng 2>/dev/null \
      || info "Could not install proxychains4 — proxy support will be disabled until installed"
  fi
fi
PROXYCHAINS_BIN=$(which proxychains4 2>/dev/null || echo "")

# --- Create .env (back up existing one if present) ---
if [ -f "$SCRIPT_DIR/.env" ]; then
  mv "$SCRIPT_DIR/.env" "$SCRIPT_DIR/.env.bkup"
  info "Existing .env backed up to .env.bkup"
fi

MUDSLIDE_BIN=$(which mudslide)
if [ -f "$SCRIPT_DIR/.env.example" ]; then
  cp "$SCRIPT_DIR/.env.example" "$SCRIPT_DIR/.env"
  sed -i.bak "s|MUDSLIDE_PATH=.*|MUDSLIDE_PATH=$MUDSLIDE_BIN|" "$SCRIPT_DIR/.env" && rm -f "$SCRIPT_DIR/.env.bak"
  sed -i.bak "s|PROXYCHAINS_PATH=.*|PROXYCHAINS_PATH=$PROXYCHAINS_BIN|" "$SCRIPT_DIR/.env" && rm -f "$SCRIPT_DIR/.env.bak"
else
  cat > "$SCRIPT_DIR/.env" <<EOF
MUDSLIDE_PATH=$MUDSLIDE_BIN
PROXYCHAINS_PATH=$PROXYCHAINS_BIN

SMTP_HOST=
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=
SMTP_PASS=
EMAIL_FROM=
REPLY_TO=

BASE_URL=http://localhost
PORT=80
NODE_ENV=production

# Residential proxy (optional — leave blank to disable)
DATAIMPULSE_USERNAME=
DATAIMPULSE_PASSWORD=
DATAIMPULSE_GATEWAY=74.81.81.81
DATAIMPULSE_PORT=10000
EOF
fi
success ".env created."
if [ -f "$SCRIPT_DIR/.env.bkup" ]; then
  echo -e "${YELLOW}[IMPORTANT] Copy your settings (SMTP, BASE_URL, DATAIMPULSE, etc.) from .env.bkup into .env before starting the server.${NC}"
fi

echo ""
success "Installation complete. Run 'npm start' to start the server."
