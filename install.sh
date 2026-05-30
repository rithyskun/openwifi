#!/usr/bin/env bash
set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

echo -e "${CYAN}"
echo "  ╔══════════════════════════════════════╗"
echo "  ║        OpenWiFi Mesh Installer       ║"
echo "  ╚══════════════════════════════════════╝"
echo -e "${NC}"

if ! command -v node &>/dev/null; then
  echo -e "${RED}  Error: Node.js is not installed.${NC}"
  echo ""
  echo "  Install it from: https://nodejs.org (v18 or later)"
  echo "  Or use your package manager:"
  echo "    macOS:  brew install node"
  echo "    Ubuntu: sudo apt install nodejs npm"
  echo "    Fedora: sudo dnf install nodejs npm"
  exit 1
fi

NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
  echo -e "${YELLOW}  Warning: Node.js v18+ recommended (found v$(node -v | sed 's/v//'))${NC}"
  echo "  Continuing anyway..."
fi
echo -e "  ${GREEN}✓${NC} Node.js $(node -v) detected"

if ! command -v npm &>/dev/null; then
  echo -e "${RED}  Error: npm is not installed.${NC}"
  exit 1
fi
echo -e "  ${GREEN}✓${NC} npm $(npm -v) detected"

echo ""
echo "  Installing dependencies..."
npm install

echo ""
echo -e "${GREEN}  ✓ Installation complete!${NC}"
echo ""
echo -e "  ${CYAN}Usage:${NC}"
echo "    npm start                                  Run with default name"
echo "    npm start -- --name \"MyNode\"               Run with custom name"
echo "    npm start -- --secret \"my passphrase\"      Encrypt database with passphrase"
echo "    OPENWIFI_SECRET=\"secret\" npm start         Set secret via env var"
echo "    node src/index.js --web-port 8080           Run on specific web port"
echo ""
echo -e "  ${CYAN}Run two nodes to test:${NC}"
echo "    Terminal 1:  npm start -- --name \"Alpha\" --secret \"my key\""
echo "    Terminal 2:  npm start -- --name \"Beta\" --secret \"my key\""
echo ""
echo -e "  Then open the Web UI URLs printed in the terminal."
echo "  Nodes on the same LAN will discover each other automatically."
echo ""
