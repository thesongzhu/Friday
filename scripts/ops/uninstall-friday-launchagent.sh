#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
REPO_DIR="$(cd "${REPO_DIR}" && pwd)"
SOCKET_PATH="${REPO_DIR}/.friday/run/system-companion.sock"
TOKEN_FILE="${REPO_DIR}/.friday/run/system-companion.auth.token"

for LABEL in "com.friday.hub" "com.friday.companion"; do
  PLIST_PATH="${HOME}/Library/LaunchAgents/${LABEL}.plist"

  if [ -f "${PLIST_PATH}" ]; then
    launchctl bootout "gui/${UID}" "${PLIST_PATH}" >/dev/null 2>&1 || true
    launchctl disable "gui/${UID}/${LABEL}" >/dev/null 2>&1 || true
    rm -f "${PLIST_PATH}"
    echo "[uninstall] removed ${PLIST_PATH}"
  else
    echo "[uninstall] plist not found: ${PLIST_PATH}"
  fi
done

rm -f "${SOCKET_PATH}" "${TOKEN_FILE}"
echo "[uninstall] removed runtime artifacts: ${SOCKET_PATH}, ${TOKEN_FILE}"
