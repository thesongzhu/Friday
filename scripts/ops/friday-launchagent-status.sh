#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
REPO_DIR="$(cd "${REPO_DIR}" && pwd)"
SOCKET_PATH="${REPO_DIR}/.friday/run/system-companion.sock"
TOKEN_FILE="${REPO_DIR}/.friday/run/system-companion.auth.token"

for LABEL in "com.friday.hub" "com.friday.companion"; do
  PLIST_PATH="${HOME}/Library/LaunchAgents/${LABEL}.plist"

  echo "label: ${LABEL}"
  echo "plist: ${PLIST_PATH}"
  if [ -f "${PLIST_PATH}" ]; then
    echo "installed: yes"
  else
    echo "installed: no"
  fi

  echo
  if launchctl list "${LABEL}" >/dev/null 2>&1; then
    launchctl list "${LABEL}" || true
  else
    echo "service: not loaded"
  fi
  if [[ "${LABEL}" == "com.friday.companion" ]]; then
    if [ -f "${TOKEN_FILE}" ]; then
      echo "shared auth token file: ${TOKEN_FILE}"
    else
      echo "shared auth token file: missing (${TOKEN_FILE})"
    fi
    if [ -S "${SOCKET_PATH}" ]; then
      echo "socket: ${SOCKET_PATH}"
    else
      echo "socket: not present (${SOCKET_PATH})"
    fi
  fi
  echo
done
