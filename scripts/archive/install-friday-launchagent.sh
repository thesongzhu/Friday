#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="${1:-}"
if [ -z "${REPO_DIR}" ]; then
  REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
fi
REPO_DIR="$(cd "${REPO_DIR}" && pwd)"

RUNNER="${REPO_DIR}/scripts/ops/friday-service-run.sh"
COMPANION_RUNNER="${REPO_DIR}/scripts/ops/friday-companion-run.sh"
UI_RUNNER="${REPO_DIR}/scripts/ops/friday-open-ui-on-login.sh"
if [ ! -x "${RUNNER}" ]; then
  echo "[install] missing executable runner: ${RUNNER}" >&2
  exit 1
fi
if [ ! -x "${COMPANION_RUNNER}" ]; then
  echo "[install] missing executable runner: ${COMPANION_RUNNER}" >&2
  exit 1
fi
if [ ! -x "${UI_RUNNER}" ]; then
  echo "[install] missing executable runner: ${UI_RUNNER}" >&2
  exit 1
fi

NODE_BIN="$(command -v node || true)"
if [ -z "${NODE_BIN}" ]; then
  echo "[install] node not found in PATH." >&2
  exit 1
fi

HUB_LABEL="com.friday.hub"
COMPANION_LABEL="com.friday.companion"
UI_LABEL="com.friday.ui-open"
AGENT_DIR="${HOME}/Library/LaunchAgents"
LOG_DIR="${HOME}/.friday/launchd"
mkdir -p "${AGENT_DIR}" "${LOG_DIR}"

SOCKET_PATH="${REPO_DIR}/.friday/run/system-companion.sock"
TOKEN_FILE="${REPO_DIR}/.friday/run/system-companion.auth.token"
mkdir -p "$(dirname "${TOKEN_FILE}")"
if [ -f "${TOKEN_FILE}" ]; then
  COMPANION_AUTH_TOKEN="$(tr -d '\n' < "${TOKEN_FILE}")"
else
  COMPANION_AUTH_TOKEN="$("${NODE_BIN}" -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))")"
  printf "%s" "${COMPANION_AUTH_TOKEN}" > "${TOKEN_FILE}"
fi

HUB_PLIST_PATH="${AGENT_DIR}/${HUB_LABEL}.plist"
COMPANION_PLIST_PATH="${AGENT_DIR}/${COMPANION_LABEL}.plist"
UI_PLIST_PATH="${AGENT_DIR}/${UI_LABEL}.plist"

HUB_STDOUT_LOG="${LOG_DIR}/friday.stdout.log"
HUB_STDERR_LOG="${LOG_DIR}/friday.stderr.log"
COMPANION_STDOUT_LOG="${LOG_DIR}/friday-companion.stdout.log"
COMPANION_STDERR_LOG="${LOG_DIR}/friday-companion.stderr.log"

cat > "${HUB_PLIST_PATH}" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${HUB_LABEL}</string>

  <key>ProgramArguments</key>
  <array>
    <string>${RUNNER}</string>
    <string>${REPO_DIR}</string>
  </array>

  <key>WorkingDirectory</key>
  <string>${REPO_DIR}</string>

  <key>RunAtLoad</key>
  <true/>

  <key>KeepAlive</key>
  <true/>

  <key>ThrottleInterval</key>
  <integer>10</integer>

  <key>EnvironmentVariables</key>
  <dict>
    <key>FRIDAY_NODE_BIN</key>
    <string>${NODE_BIN}</string>
    <key>FRIDAY_SYSTEM_COMPANION_SERVER_MODE</key>
    <string>external</string>
    <key>FRIDAY_SYSTEM_NATIVE_COMPANION_MODE</key>
    <string>auto</string>
    <key>FRIDAY_SYSTEM_COMPANION_AUTH_TOKEN</key>
    <string>${COMPANION_AUTH_TOKEN}</string>
    <key>FRIDAY_SYSTEM_COMPANION_AUTH_TOKEN_FILE</key>
    <string>${TOKEN_FILE}</string>
    <key>FRIDAY_SYSTEM_COMPANION_SOCKET_PATH</key>
    <string>${SOCKET_PATH}</string>
    <key>PATH</key>
    <string>${PATH}</string>
  </dict>

  <key>StandardOutPath</key>
  <string>${HUB_STDOUT_LOG}</string>
  <key>StandardErrorPath</key>
  <string>${HUB_STDERR_LOG}</string>
</dict>
</plist>
EOF

cat > "${COMPANION_PLIST_PATH}" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${COMPANION_LABEL}</string>

  <key>ProgramArguments</key>
  <array>
    <string>${COMPANION_RUNNER}</string>
    <string>${REPO_DIR}</string>
  </array>

  <key>WorkingDirectory</key>
  <string>${REPO_DIR}</string>

  <key>RunAtLoad</key>
  <true/>

  <key>KeepAlive</key>
  <true/>

  <key>ThrottleInterval</key>
  <integer>10</integer>

  <key>EnvironmentVariables</key>
  <dict>
    <key>FRIDAY_NODE_BIN</key>
    <string>${NODE_BIN}</string>
    <key>FRIDAY_SYSTEM_NATIVE_COMPANION_MODE</key>
    <string>auto</string>
    <key>FRIDAY_SYSTEM_COMPANION_AUTH_TOKEN</key>
    <string>${COMPANION_AUTH_TOKEN}</string>
    <key>FRIDAY_SYSTEM_COMPANION_AUTH_TOKEN_FILE</key>
    <string>${TOKEN_FILE}</string>
    <key>FRIDAY_SYSTEM_COMPANION_SOCKET_PATH</key>
    <string>${SOCKET_PATH}</string>
    <key>PATH</key>
    <string>${PATH}</string>
  </dict>

  <key>StandardOutPath</key>
  <string>${COMPANION_STDOUT_LOG}</string>
  <key>StandardErrorPath</key>
  <string>${COMPANION_STDERR_LOG}</string>
</dict>
</plist>
EOF

cat > "${UI_PLIST_PATH}" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${UI_LABEL}</string>

  <key>ProgramArguments</key>
  <array>
    <string>${UI_RUNNER}</string>
    <string>${REPO_DIR}</string>
  </array>

  <key>WorkingDirectory</key>
  <string>${REPO_DIR}</string>

  <key>RunAtLoad</key>
  <true/>

  <key>ThrottleInterval</key>
  <integer>10</integer>

  <key>EnvironmentVariables</key>
  <dict>
    <key>FRIDAY_NODE_BIN</key>
    <string>${NODE_BIN}</string>
    <key>FRIDAY_AUTO_OPEN_UI</key>
    <string>true</string>
    <key>PATH</key>
    <string>${PATH}</string>
  </dict>

  <key>StandardOutPath</key>
  <string>${LOG_DIR}/friday-ui-open.stdout.log</string>
  <key>StandardErrorPath</key>
  <string>${LOG_DIR}/friday-ui-open.stderr.log</string>
</dict>
</plist>
EOF

launchctl bootout "gui/${UID}" "${COMPANION_PLIST_PATH}" >/dev/null 2>&1 || true
launchctl enable "gui/${UID}/${COMPANION_LABEL}" >/dev/null 2>&1 || true
launchctl bootstrap "gui/${UID}" "${COMPANION_PLIST_PATH}"
launchctl kickstart -k "gui/${UID}/${COMPANION_LABEL}"

launchctl bootout "gui/${UID}" "${HUB_PLIST_PATH}" >/dev/null 2>&1 || true
launchctl enable "gui/${UID}/${HUB_LABEL}" >/dev/null 2>&1 || true
launchctl bootstrap "gui/${UID}" "${HUB_PLIST_PATH}"
launchctl kickstart -k "gui/${UID}/${HUB_LABEL}"

launchctl bootout "gui/${UID}" "${UI_PLIST_PATH}" >/dev/null 2>&1 || true
launchctl enable "gui/${UID}/${UI_LABEL}" >/dev/null 2>&1 || true
launchctl bootstrap "gui/${UID}" "${UI_PLIST_PATH}"
launchctl kickstart -k "gui/${UID}/${UI_LABEL}"

echo "[install] installed launch agents:"
echo "[install]   ${HUB_PLIST_PATH}"
echo "[install]   ${COMPANION_PLIST_PATH}"
echo "[install]   ${UI_PLIST_PATH}"
echo "[install] labels: ${HUB_LABEL}, ${COMPANION_LABEL}, ${UI_LABEL}"
echo "[install] logs:"
echo "[install]   hub: ${HUB_STDOUT_LOG} / ${HUB_STDERR_LOG}"
echo "[install]   companion: ${COMPANION_STDOUT_LOG} / ${COMPANION_STDERR_LOG}"
echo "[install]   ui-open: ${LOG_DIR}/friday-ui-open.stdout.log / ${LOG_DIR}/friday-ui-open.stderr.log"
echo "[install] status:"
echo "[install]   launchctl print gui/${UID}/${HUB_LABEL}"
echo "[install]   launchctl print gui/${UID}/${COMPANION_LABEL}"
echo "[install]   launchctl print gui/${UID}/${UI_LABEL}"
echo "[install] shared companion auth token: ${TOKEN_FILE}"
