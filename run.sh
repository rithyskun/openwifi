#!/usr/bin/env bash
set -e

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
NC='\033[0m'

echo -e "${CYAN}"
echo "  ╔══════════════════════════════════════╗"
echo "  ║          OpenWiFi Mesh Node          ║"
echo "  ╚══════════════════════════════════════╝"
echo -e "${NC}"

if ! command -v node &>/dev/null; then
  echo -e "${RED}  Error: Node.js is not installed.${NC}"
  echo "  Download from: https://nodejs.org (v18+)"
  exit 1
fi

NODE_MAJOR=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo -e "${YELLOW}  Warning: Node.js v18+ recommended (found v$(node -v | sed 's/v//'))${NC}"
fi

echo -e "  ${GREEN}✓${NC} Node.js $(node -v)"
echo -e "  ${GREEN}✓${NC} $(npm -v)"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

if [ ! -d "node_modules" ]; then
  echo ""
  echo -e "  ${YELLOW}Installing dependencies...${NC}"
  npm install
  echo ""
fi

echo ""
echo -e "  ${CYAN}Starting node...${NC}"
echo ""

exec node src/index.js "$@"
