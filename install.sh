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

info "Detected: $OS_NAME / $ARCH_NAME"

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

  # Build expected binary name pattern
  BINARY_PATTERN="mudslide-${OS_NAME}-${ARCH_NAME}"
  info "Looking for asset matching: $BINARY_PATTERN"

  DOWNLOAD_URL=$(echo "$LATEST_JSON" | grep -o '"browser_download_url": *"[^"]*'"$BINARY_PATTERN"'[^"]*"' | grep -o 'https://[^"]*' | head -1)

  if [ -z "$DOWNLOAD_URL" ]; then
    error "No mudslide binary found for $OS_NAME/$ARCH_NAME. Check https://github.com/robvanderleek/mudslide/releases"
  fi

  info "Downloading $DOWNLOAD_URL..."
  TMPFILE=$(mktemp)
  curl -fsSL "$DOWNLOAD_URL" -o "$TMPFILE"
  chmod +x "$TMPFILE"

  sudo mv "$TMPFILE" /usr/local/bin/mudslide
  success "mudslide installed to /usr/local/bin/mudslide"
fi

# Verify
mudslide --version 2>/dev/null && success "mudslide $(mudslide --version) ready" || info "mudslide installed (version check not available)"

# --- Create .env if missing ---
if [ ! -f "$SCRIPT_DIR/.env" ]; then
  info "Creating .env from .env.example..."
  if [ -f "$SCRIPT_DIR/.env.example" ]; then
    cp "$SCRIPT_DIR/.env.example" "$SCRIPT_DIR/.env"
    # Generate a random SERVER_SECRET
    SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
    sed -i.bak "s/SERVER_SECRET=.*/SERVER_SECRET=$SECRET/" "$SCRIPT_DIR/.env" && rm -f "$SCRIPT_DIR/.env.bak"
    info ".env created. Edit it to configure SMTP settings."
  else
    cat > "$SCRIPT_DIR/.env" <<EOF
PORT=3000
SERVER_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
SMTP_HOST=localhost
SMTP_PORT=1025
SMTP_SECURE=false
SMTP_USER=
SMTP_PASS=
EMAIL_FROM=noreply@watobot.local
BASE_URL=http://localhost:3000
EOF
    info ".env created with generated SERVER_SECRET. Edit SMTP settings before use."
  fi
else
  success ".env already exists"
fi

echo ""
success "Installation complete. Run 'npm start' to start the server."
