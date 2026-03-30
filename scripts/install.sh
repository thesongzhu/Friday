#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
#  Friday — Quick Install Script
#
#  Usage:
#    curl -fsSL https://raw.githubusercontent.com/thesongzhu/friday/main/scripts/install.sh | bash
#
#  What it does:
#    1. Checks Node.js >=22
#    2. Clones & builds Friday from source
#    3. Optionally creates a systemd service
#    4. Prints the command to start Friday
# ─────────────────────────────────────────────────────────────
set -euo pipefail

FRIDAY_REPO="https://github.com/thesongzhu/friday.git"
FRIDAY_INSTALL_DIR="${FRIDAY_INSTALL_DIR:-$HOME/friday}"
FRIDAY_BRANCH="${FRIDAY_BRANCH:-main}"
MIN_NODE_VERSION=22

# ─── Colors ──────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

info()  { echo -e "${BLUE}[friday]${NC} $*"; }
ok()    { echo -e "${GREEN}[friday]${NC} $*"; }
warn()  { echo -e "${YELLOW}[friday]${NC} $*"; }
fail()  { echo -e "${RED}[friday]${NC} $*"; exit 1; }

# ─── Pre-flight checks ──────────────────────────────────────

info "Checking prerequisites..."

# Check Node.js
if ! command -v node &>/dev/null; then
  fail "Node.js is not installed. Please install Node.js >= ${MIN_NODE_VERSION}:
    # Ubuntu/Debian:
    curl -fsSL https://deb.nodesource.com/setup_${MIN_NODE_VERSION}.x | sudo -E bash -
    sudo apt-get install -y nodejs

    # macOS (Homebrew):
    brew install node@${MIN_NODE_VERSION}

    # Or use nvm:
    curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
    nvm install ${MIN_NODE_VERSION}"
fi

NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VERSION" -lt "$MIN_NODE_VERSION" ]; then
  fail "Node.js ${MIN_NODE_VERSION}+ required (found v$(node -v | sed 's/v//')). Please upgrade."
fi
ok "Node.js v$(node -v | sed 's/v//') ✓"

# Check npm
if ! command -v npm &>/dev/null; then
  fail "npm is not installed. It should come with Node.js."
fi
ok "npm v$(npm -v) ✓"

# Check git
if ! command -v git &>/dev/null; then
  fail "git is not installed. Please install git:
    sudo apt-get install -y git    # Debian/Ubuntu
    brew install git                # macOS"
fi
ok "git ✓"

# ─── Clone & Build ──────────────────────────────────────────

if [ -d "$FRIDAY_INSTALL_DIR" ]; then
  warn "Directory $FRIDAY_INSTALL_DIR already exists."
  info "Pulling latest changes..."
  cd "$FRIDAY_INSTALL_DIR"
  git pull origin "$FRIDAY_BRANCH" || warn "Pull failed, continuing with existing code."
else
  info "Cloning Friday into $FRIDAY_INSTALL_DIR..."
  git clone --depth 1 --branch "$FRIDAY_BRANCH" "$FRIDAY_REPO" "$FRIDAY_INSTALL_DIR"
  cd "$FRIDAY_INSTALL_DIR"
fi

info "Installing dependencies..."
npm ci --prefer-offline 2>/dev/null || npm install

info "Building Friday..."
npm run build

ok "Friday built successfully!"

# ─── Link CLI (optional) ────────────────────────────────────

if [ -f "$FRIDAY_INSTALL_DIR/package.json" ]; then
  info "Linking 'friday' command globally..."
  npm link 2>/dev/null && ok "'friday' command is now available globally." || warn "npm link failed — you can run Friday directly: node $FRIDAY_INSTALL_DIR/dist/cli/friday-cli.js start"
fi

# ─── Systemd service (optional) ─────────────────────────────

setup_systemd() {
  local SERVICE_FILE="/etc/systemd/system/friday.service"

  if [ ! -d /run/systemd/system ]; then
    warn "systemd not detected, skipping service creation."
    return
  fi

  info "Creating systemd service..."

  sudo tee "$SERVICE_FILE" > /dev/null <<EOF
[Unit]
Description=Friday AI Automation Hub
After=network.target

[Service]
Type=simple
User=$USER
WorkingDirectory=$FRIDAY_INSTALL_DIR
ExecStart=$(command -v node) $FRIDAY_INSTALL_DIR/dist/cli/friday-cli.js start
Restart=on-failure
RestartSec=5
Environment=NODE_ENV=production
Environment=FRIDAY_STATE_DIR=$HOME/.friday

[Install]
WantedBy=multi-user.target
EOF

  sudo systemctl daemon-reload
  sudo systemctl enable friday
  ok "Systemd service created. Use: sudo systemctl start friday"
}

echo ""
read -rp "Create a systemd service for Friday? [y/N]: " REPLY
if [[ "$REPLY" =~ ^[Yy]$ ]]; then
  setup_systemd
fi

# ─── Done ────────────────────────────────────────────────────

echo ""
echo -e "${GREEN}╔══════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║           Friday installed successfully!          ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════════════╝${NC}"
echo ""
echo "  Start Friday:"
echo "    friday start"
echo ""
echo "  Or with options:"
echo "    friday start --port 3141 --host 0.0.0.0"
echo ""
echo "  Then open: http://localhost:3141"
echo ""
echo "  For Docker instead:"
echo "    docker compose up -d"
echo ""
