#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
REPO_DIR="$(cd "${REPO_DIR}" && pwd)"
SOCKET_PATH="${REPO_DIR}/.friday/run/system-companion.sock"
TOKEN_FILE="${REPO_DIR}/.friday/run/system-companion.auth.token"
RUN_DIR="${HOME}/.friday/run"

for LABEL in "com.friday.hub" "com.friday.companion" "com.friday.ui-open"; do
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
rm -f "${RUN_DIR}/ui-opened-"* "${RUN_DIR}/ui-launch-mode.txt" >/dev/null 2>&1 || true
echo "[uninstall] removed runtime artifacts: ${SOCKET_PATH}, ${TOKEN_FILE}"
