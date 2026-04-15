#!/usr/bin/env bash
set -Eeuo pipefail

REPO_DIR="${1:-}"
if [[ -z "${REPO_DIR}" ]]; then
  REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
fi

if [[ ! -d "${REPO_DIR}" ]]; then
  echo "[friday-ui-open] workspace not found: ${REPO_DIR}" >&2
  exit 78
fi

if [[ "${FRIDAY_AUTO_OPEN_UI:-true}" == "false" ]]; then
  echo "[friday-ui-open] auto-open disabled" >&2
  exit 0
fi

if ! command -v open >/dev/null 2>&1; then
  echo "[friday-ui-open] macOS open command not available" >&2
  exit 78
fi

SESSION_KEY="${SECURITYSESSIONID:-}"
if [[ -z "${SESSION_KEY}" ]]; then
  SESSION_KEY="$(sysctl -n kern.boottime 2>/dev/null | awk -F'[ ,}]+' '{for (i=1; i<=NF; i++) if ($i == "sec") {print $(i+1); exit}}')"
fi
if [[ -z "${SESSION_KEY}" ]]; then
  SESSION_KEY="default"
fi

RUN_DIR="${HOME}/.friday/run"
STAMP_PATH="${RUN_DIR}/ui-opened-${SESSION_KEY}.stamp"
MODE_PATH="${RUN_DIR}/ui-launch-mode.txt"
mkdir -p "${RUN_DIR}"

if [[ -f "${STAMP_PATH}" ]]; then
  echo "[friday-ui-open] UI already opened for session ${SESSION_KEY}" >&2
  exit 0
fi

UI_URL="$(
  REPO_DIR="${REPO_DIR}" node --input-type=commonjs <<'NODE'
const path = require("node:path");
const fs = require("node:fs");
const Database = require("better-sqlite3");

function resolveStateDir() {
  if (process.env.FRIDAY_STATE_DIR && process.env.FRIDAY_STATE_DIR.trim().length > 0) {
    return process.env.FRIDAY_STATE_DIR.trim();
  }
  if (process.platform === "darwin") {
    return path.join(process.env.HOME || "", "Library", "Application Support", "Friday", "state");
  }
  if (process.platform === "linux") {
    return path.join(process.env.XDG_STATE_HOME || path.join(process.env.HOME || "", ".local", "state"), "friday");
  }
  return path.join(process.env.HOME || "", ".friday", "state");
}

const envHost = (process.env.FRIDAY_HOST || "").trim();
const envPort = Number.parseInt(process.env.FRIDAY_PORT || "", 10);
let host = envHost || "";
let port = Number.isInteger(envPort) ? envPort : 0;
const dbPath = path.join(resolveStateDir(), "friday.db");

if ((!host || !port) && fs.existsSync(dbPath)) {
  try {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const row = db
      .prepare("SELECT network_host, network_port FROM friday_setup_state WHERE id = 'singleton'")
      .get();
    db.close();
    if (!host && typeof row?.network_host === "string" && row.network_host.trim().length > 0) {
      host = row.network_host.trim();
    }
    if (!port && Number.isInteger(row?.network_port) && row.network_port > 0) {
      port = row.network_port;
    }
  } catch {
    // Ignore and fall back.
  }
}

if (!host) host = "127.0.0.1";
if (!port) port = 3141;
if (host === "0.0.0.0" || host === "localhost") {
  host = "127.0.0.1";
}
process.stdout.write(`http://${host}:${port}`);
NODE
)"

HEALTH_URL="${UI_URL}/v1/health"
DEADLINE=$((SECONDS + 60))
until curl -fsS --max-time 2 "${HEALTH_URL}" >/dev/null 2>&1; do
  if (( SECONDS >= DEADLINE )); then
    echo "[friday-ui-open] timed out waiting for ${HEALTH_URL}" >&2
    exit 70
  fi
  sleep 1
done

open "${UI_URL}" >/dev/null 2>&1 || {
  echo "[friday-ui-open] failed to open ${UI_URL}" >&2
  exit 70
}

printf "browser:%s\n" "${UI_URL}" > "${MODE_PATH}"
printf "%s\n" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "${STAMP_PATH}"
echo "[friday-ui-open] opened ${UI_URL}" >&2
