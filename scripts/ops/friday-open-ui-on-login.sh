#!/usr/bin/env bash
set -Eeuo pipefail

REPO_DIR="${1:-}"
if [[ -z "${REPO_DIR}" ]]; then
  REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
fi

if [[ "${FRIDAY_AUTO_OPEN_UI:-true}" == "false" ]]; then
  exit 0
fi

cd "${REPO_DIR}" 2>/dev/null || true

HOST="${FRIDAY_HOST:-127.0.0.1}"
if [[ "${HOST}" == "0.0.0.0" ]]; then
  HOST="localhost"
fi
PORT="${FRIDAY_PORT:-3141}"
BASE_URL="${FRIDAY_PUBLIC_APP_BASE_URL:-http://${HOST}:${PORT}}"
HEALTH_URL="${BASE_URL%/}/v1/health"

attempts="${FRIDAY_OPEN_UI_WAIT_ATTEMPTS:-90}"
sleep_seconds="${FRIDAY_OPEN_UI_WAIT_SECONDS:-1}"

for ((i = 0; i < attempts; i += 1)); do
  if command -v curl >/dev/null 2>&1; then
    if curl -fsS "${HEALTH_URL}" >/dev/null 2>&1; then
      break
    fi
  else
    break
  fi
  sleep "${sleep_seconds}"
done

case "$(uname -s)" in
  Darwin)
    exec open "${BASE_URL%/}/"
    ;;
  Linux)
    exec xdg-open "${BASE_URL%/}/"
    ;;
  MINGW*|MSYS*|CYGWIN*)
    exec rundll32.exe url.dll,FileProtocolHandler "${BASE_URL%/}/"
    ;;
  *)
    echo "[friday-ui-open] unsupported platform for auto-open: $(uname -s)" >&2
    exit 0
    ;;
esac
