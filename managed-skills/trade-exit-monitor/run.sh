#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# Find node: prefer PATH, fall back to common locations
NODE_BIN="${NODE_BIN:-$(command -v node 2>/dev/null || echo "")}"
[ -z "$NODE_BIN" ] && [ -x "/opt/homebrew/bin/node" ] && NODE_BIN="/opt/homebrew/bin/node"
[ -z "$NODE_BIN" ] && [ -x "/usr/local/bin/node" ] && NODE_BIN="/usr/local/bin/node"
[ -z "$NODE_BIN" ] && { echo '{"error":"node not found"}'; exit 1; }
exec "$NODE_BIN" "${SCRIPT_DIR}/index.mjs"
