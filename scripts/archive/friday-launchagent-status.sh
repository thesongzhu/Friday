#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
REPO_DIR="$(cd "${REPO_DIR}" && pwd)"
SOCKET_PATH="${REPO_DIR}/.friday/run/system-companion.sock"
TOKEN_FILE="${REPO_DIR}/.friday/run/system-companion.auth.token"
UI_MODE_PATH="${HOME}/.friday/run/ui-launch-mode.txt"

print_launchctl_summary() {
  local label="$1"
  local plist_path="$2"
  local installed="no"
  local loaded="no"
  local pid="-"
  local last_exit="-"

  if [[ -f "${plist_path}" ]]; then
    installed="yes"
  fi

  if launchctl list | awk -v target="${label}" '$3 == target {found=1} END {exit found ? 0 : 1}' >/dev/null 2>&1; then
    loaded="yes"
    local summary
    summary="$(launchctl list | awk -v target="${label}" '$3 == target {print $1 " " $2; exit}')"
    pid="${summary%% *}"
    last_exit="${summary##* }"
  fi

  echo "label: ${label}"
  echo "plist: ${plist_path}"
  echo "installed: ${installed}"
  echo "loaded: ${loaded}"
  echo "pid: ${pid}"
  echo "last_exit_status: ${last_exit}"
}

read_channel_source() {
  REPO_DIR="${REPO_DIR}" node --input-type=commonjs <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
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

function hasLegacyChannels() {
  const legacyPath = path.join(process.env.HOME || "", ".friday", "friday.json");
  if (!fs.existsSync(legacyPath)) return false;
  try {
    const parsed = JSON.parse(fs.readFileSync(legacyPath, "utf8"));
    return parsed && typeof parsed === "object" && parsed.channels && typeof parsed.channels === "object";
  } catch {
    return false;
  }
}

if ((process.env.FRIDAY_CHANNELS_JSON || "").trim().length > 0) {
  process.stdout.write("env_override");
  process.exit(0);
}

const dbPath = path.join(resolveStateDir(), "friday.db");
if (fs.existsSync(dbPath)) {
  try {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const row = db
      .prepare("SELECT channels_json FROM friday_setup_state WHERE id = 'singleton'")
      .get();
    db.close();
    if (typeof row?.channels_json === "string") {
      const parsed = JSON.parse(row.channels_json);
      if (Array.isArray(parsed) && parsed.length > 0) {
        process.stdout.write(hasLegacyChannels() ? "setup_state (legacy compat cleanup pending)" : "setup_state");
        process.exit(0);
      }
    }
  } catch {
    // Ignore and fall through.
  }
}

process.stdout.write(hasLegacyChannels() ? "legacy_compat" : "none");
NODE
}

echo "Friday launchd status"
echo "repo: ${REPO_DIR}"
echo

for LABEL in "com.friday.hub" "com.friday.companion"; do
  PLIST_PATH="${HOME}/Library/LaunchAgents/${LABEL}.plist"
  print_launchctl_summary "${LABEL}" "${PLIST_PATH}"
  if [[ "${LABEL}" == "com.friday.companion" ]]; then
    if [[ -f "${TOKEN_FILE}" ]]; then
      echo "shared_auth_token_file: present (${TOKEN_FILE})"
    else
      echo "shared_auth_token_file: missing (${TOKEN_FILE})"
    fi
    if [[ -S "${SOCKET_PATH}" ]]; then
      echo "companion_socket: present (${SOCKET_PATH})"
    else
      echo "companion_socket: missing (${SOCKET_PATH})"
    fi
  fi
  echo
done

echo "ui_launch_mode: $(cat "${UI_MODE_PATH}" 2>/dev/null || echo "browser_fallback (waiting or not yet opened)")"
echo "channel_config_source: $(read_channel_source)"
