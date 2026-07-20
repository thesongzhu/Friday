#!/usr/bin/env bash
set -Eeuo pipefail

REPO_DIR=""
STATE_DIR=""
KICKSTART="true"

usage() {
  cat <<'EOF'
Usage:
  scripts/ops/install-friday-launchagent.sh [repo-dir] [options]

Options:
  --state-dir <path>  Use this Friday state directory when launchd starts Friday.
  --no-kickstart      Install launch agents without starting them immediately.
  -h, --help          Show this help.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --state-dir)
      if [[ $# -lt 2 ]]; then
        echo "Missing value for --state-dir" >&2
        exit 2
      fi
      STATE_DIR="$2"
      shift 2
      ;;
    --no-kickstart)
      KICKSTART="false"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      if [[ -z "${REPO_DIR}" ]]; then
        REPO_DIR="$1"
        shift
      else
        echo "Unknown argument: $1" >&2
        usage
        exit 2
      fi
      ;;
  esac
done

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "[install] macOS LaunchAgents require Darwin. Use 'friday daemon start' on this platform." >&2
  exit 78
fi

if [[ -z "${REPO_DIR}" ]]; then
  REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
fi
REPO_DIR="$(cd "${REPO_DIR}" && pwd)"

RUNNER="${REPO_DIR}/scripts/ops/friday-service-run.sh"
COMPANION_RUNNER="${REPO_DIR}/scripts/ops/friday-companion-run.sh"
UI_RUNNER="${REPO_DIR}/scripts/ops/friday-open-ui-on-login.sh"
for runner in "${RUNNER}" "${COMPANION_RUNNER}" "${UI_RUNNER}"; do
  if [[ ! -x "${runner}" ]]; then
    echo "[install] missing executable runner: ${runner}" >&2
    exit 1
  fi
done

NODE_BIN="$(command -v node || true)"
if [[ -z "${NODE_BIN}" ]]; then
  echo "[install] node not found in PATH." >&2
  exit 1
fi

HUB_LABEL="com.friday.hub"
COMPANION_LABEL="com.friday.companion"
UI_LABEL="com.friday.ui-open"
AGENT_DIR="${HOME}/Library/LaunchAgents"
LOG_DIR="${HOME}/.friday/launchd"
mkdir -p "${AGENT_DIR}" "${LOG_DIR}"

RUN_DIR="${FRIDAY_RUN_DIR:-${HOME}/.friday/run}"
SOCKET_PATH="${RUN_DIR}/system-companion.sock"
TOKEN_FILE="${RUN_DIR}/system-companion.auth.token"
mkdir -p "$(dirname "${TOKEN_FILE}")"
if [[ -f "${TOKEN_FILE}" ]]; then
  COMPANION_AUTH_TOKEN="$(tr -d '\n' < "${TOKEN_FILE}")"
else
  COMPANION_AUTH_TOKEN="$("${NODE_BIN}" -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))")"
  printf "%s" "${COMPANION_AUTH_TOKEN}" > "${TOKEN_FILE}"
  chmod 600 "${TOKEN_FILE}"
fi

HUB_PLIST_PATH="${AGENT_DIR}/${HUB_LABEL}.plist"
COMPANION_PLIST_PATH="${AGENT_DIR}/${COMPANION_LABEL}.plist"
UI_PLIST_PATH="${AGENT_DIR}/${UI_LABEL}.plist"

# =============================================================================
# CORE-A round-3 Lane C (finding #4): resolve whether to install + launch the Rust
# agent-run WS server (com.friday.rust-agent-run-ws-server) as a 4th launch agent.
# =============================================================================
# The release runtime routes a qualifying agent-run / session create+append to this
# loopback sealed-WS server; TS startRun is retired to a fail-closed 503 with NO
# silent fallback. Before this, the packaged install shipped/launched NO Rust server,
# so a clean install hit 503 on every run. This promotes the DARK cutover (fill plist,
# plutil -lint, port check, provision ~/.friday/master.key, hub_agent_run_enroll,
# launchctl bootstrap) into the installer so it happens WITHOUT a human.
#
# It stays a no-op (byte-identical to the pre-Lane-C 3-agent install) UNLESS a staged
# Rust payload is found — i.e. only in a packaged release install (the DMG's / source
# distribution's rust-agent-run/ folder), or when explicitly opted in for a dev tree.
RUST_LABEL="com.friday.rust-agent-run-ws-server"
RUST_PLIST_PATH="${AGENT_DIR}/${RUST_LABEL}.plist"
RUST_AGENT_ENABLED="false"
RUST_PAYLOAD_DIR=""
RUST_SERVER_BIN=""
RUST_ENROLL_BIN=""
RUST_PLIST_TEMPLATE=""

rust_truthy() { case "$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]')" in 1|true|yes|on) return 0 ;; *) return 1 ;; esac; }

# Locate a staged payload (both bins + the plist template). Search order:
#   1) FRIDAY_RUST_AGENT_RUN_PAYLOAD_DIR (explicit)
#   2) <repo>/rust-agent-run  (packaged: extracted / DMG-copied next to the app or repo)
#   3) with FRIDAY_INSTALL_RUST_AGENT_RUN truthy: <repo>/rust-core/target/release (dev)
resolve_rust_payload() {
  local candidates=()
  [[ -n "${FRIDAY_RUST_AGENT_RUN_PAYLOAD_DIR:-}" ]] && candidates+=("${FRIDAY_RUST_AGENT_RUN_PAYLOAD_DIR}")
  candidates+=("${REPO_DIR}/rust-agent-run")
  if rust_truthy "${FRIDAY_INSTALL_RUST_AGENT_RUN:-}"; then
    candidates+=("${REPO_DIR}/rust-core/target/release")
  fi
  local dir server enroll template
  for dir in "${candidates[@]}"; do
    server="${dir}/hub_agent_run_server"
    enroll="${dir}/hub_agent_run_enroll"
    [[ -x "${server}" && -x "${enroll}" ]] || continue
    # The plist template travels with the staged payload; fall back to the repo path.
    if [[ -f "${dir}/${RUST_LABEL}.plist" ]]; then
      template="${dir}/${RUST_LABEL}.plist"
    elif [[ -f "${REPO_DIR}/scripts/ops/launchd/${RUST_LABEL}.plist" ]]; then
      template="${REPO_DIR}/scripts/ops/launchd/${RUST_LABEL}.plist"
    else
      continue
    fi
    RUST_PAYLOAD_DIR="${dir}"; RUST_SERVER_BIN="${server}"
    RUST_ENROLL_BIN="${enroll}"; RUST_PLIST_TEMPLATE="${template}"
    return 0
  done
  return 1
}

if resolve_rust_payload; then
  RUST_AGENT_ENABLED="true"
  RUST_STORE_DIR="${FRIDAY_HUB_AGENT_RUN_STORE_DIR:-${HOME}/.friday/agent-run-securestore}"
  RUST_WORKSPACE_ROOT="${FRIDAY_HUB_AGENT_RUN_WORKSPACE:-${HOME}/.friday/agent-run/workspace}"
  RUST_HUB_DB_PATH="${FRIDAY_HUB_AGENT_RUN_DB_PATH:-${HOME}/.friday/agent-run/hub.sqlite}"
  # The OWNER allowlist entry MUST equal the TS hub's authenticated principal or every
  # dispatch is refused (fail-closed). It is deploy-specific, so it is an operator input;
  # a wrong/placeholder value never fakes success — it 503s. Documented default flagged below.
  RUST_OWNER_PRINCIPAL="${FRIDAY_HUB_AGENT_RUN_OWNER_PRINCIPAL:-owner:local}"
  # Pick a stable, free loopback port distinct from the hub port (default 3141) unless pinned.
  if [[ -n "${FRIDAY_HUB_AGENT_RUN_WS_PORT:-}" ]]; then
    RUST_WS_PORT="${FRIDAY_HUB_AGENT_RUN_WS_PORT}"
  else
    RUST_WS_PORT="$("${NODE_BIN}" -e "const net=require('node:net');const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>console.log(p));});" 2>/dev/null || echo "")"
    [[ "${RUST_WS_PORT}" =~ ^[0-9]+$ ]] || RUST_WS_PORT="61789"
  fi
fi

write_common_env() {
  cat <<EOF
    <key>FRIDAY_NODE_BIN</key>
    <string>${NODE_BIN}</string>
    <key>FRIDAY_BUILD_ON_START</key>
    <string>auto</string>
    <key>PATH</key>
    <string>${PATH}</string>
EOF
  if [[ -n "${STATE_DIR}" ]]; then
    cat <<EOF
    <key>FRIDAY_STATE_DIR</key>
    <string>${STATE_DIR}</string>
EOF
  fi
}

# CORE-A Lane C (finding #4): when the Rust agent-run WS server is installed, the TS hub
# must know the loopback PORT to dial + the Hub DB the owner-gated answer readback reads
# from. These are pure transport-wiring (NOT the route flag — the release profile default
# from CR-3 needs no flag; an explicit FRIDAY_ROUTE_*_VIA_RUST=0 remains the kill switch).
# No secret goes here (the WS X25519 secret is SecureStore-derived on the TS side; the
# server reads its own master key). Empty when the Rust agent is not installed.
write_hub_agent_run_env() {
  if [[ "${RUST_AGENT_ENABLED}" != "true" ]]; then
    return 0
  fi
  cat <<EOF
    <key>FRIDAY_HUB_AGENT_RUN_WS_HOST</key>
    <string>127.0.0.1</string>
    <key>FRIDAY_HUB_AGENT_RUN_WS_PORT</key>
    <string>${RUST_WS_PORT}</string>
    <key>FRIDAY_HUB_AGENT_RUN_DB_PATH</key>
    <string>${RUST_HUB_DB_PATH}</string>
EOF
}

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
$(write_common_env)
$(write_hub_agent_run_env)
    <key>FRIDAY_AUTO_OPEN_UI</key>
    <string>false</string>
    <key>FRIDAY_CHANNEL_WAKE_UI</key>
    <string>false</string>
    <key>FRIDAY_CANONICAL_GATE</key>
    <string>true</string>
    <key>FRIDAY_SYSTEM_ENABLED</key>
    <string>true</string>
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
  </dict>
  <key>StandardOutPath</key>
  <string>${LOG_DIR}/friday.stdout.log</string>
  <key>StandardErrorPath</key>
  <string>${LOG_DIR}/friday.stderr.log</string>
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
$(write_common_env)
    <key>FRIDAY_SYSTEM_NATIVE_COMPANION_MODE</key>
    <string>auto</string>
    <key>FRIDAY_SYSTEM_COMPANION_AUTH_TOKEN</key>
    <string>${COMPANION_AUTH_TOKEN}</string>
    <key>FRIDAY_SYSTEM_COMPANION_AUTH_TOKEN_FILE</key>
    <string>${TOKEN_FILE}</string>
    <key>FRIDAY_SYSTEM_COMPANION_SOCKET_PATH</key>
    <string>${SOCKET_PATH}</string>
  </dict>
  <key>StandardOutPath</key>
  <string>${LOG_DIR}/friday-companion.stdout.log</string>
  <key>StandardErrorPath</key>
  <string>${LOG_DIR}/friday-companion.stderr.log</string>
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
$(write_common_env)
    <key>FRIDAY_AUTO_OPEN_UI</key>
    <string>true</string>
  </dict>
  <key>StandardOutPath</key>
  <string>${LOG_DIR}/friday-ui-open.stdout.log</string>
  <key>StandardErrorPath</key>
  <string>${LOG_DIR}/friday-ui-open.stderr.log</string>
</dict>
</plist>
EOF

if [[ "${KICKSTART}" == "true" ]]; then
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
  launchctl kickstart -k "gui/${UID}/${UI_LABEL}" >/dev/null 2>&1 || true
else
  echo "[install] launch agents written; kickstart skipped."
fi

# =============================================================================
# CORE-A round-3 Lane C (finding #4): install + enroll + launch the Rust agent-run
# WS server (the promoted DARK cutover). Best-effort + fail-CLOSED: any problem here
# is surfaced but never rolls back the base 3 agents (no degrade of prior behavior).
# =============================================================================
# escape a value for a sed replacement (\, &, / delimiter) — mirrors the DARK tool.
rust_sed_escape() { printf '%s' "$1" | sed -e 's/[\\&/]/\\&/g'; }

install_rust_agent_run_ws_server() {
  # Stable install locations (survive DMG unmount / tarball dir removal).
  local bin_dir="${HOME}/.friday/agent-run/bin"
  local server_bin="${bin_dir}/hub_agent_run_server"
  local enroll_bin="${bin_dir}/hub_agent_run_enroll"
  local master_key_file="${HOME}/.friday/master.key"

  mkdir -p "${bin_dir}" "${RUST_STORE_DIR}" "${RUST_WORKSPACE_ROOT}" \
           "$(dirname "${RUST_HUB_DB_PATH}")" || { echo "[install] rust: mkdir failed" >&2; return 1; }
  install -m 0755 "${RUST_SERVER_BIN}" "${server_bin}" || { echo "[install] rust: staging server bin failed" >&2; return 1; }
  install -m 0755 "${RUST_ENROLL_BIN}" "${enroll_bin}" || { echo "[install] rust: staging enroll bin failed" >&2; return 1; }

  # (provision master key) The server reads FRIDAY_MASTER_KEY or ~/.friday/master.key
  # (never auto-generated on the Rust side). On a clean install provision the FILE so the
  # server is bootable; the TS hub adopts the same file key when no keychain key pre-exists.
  if [[ -z "${FRIDAY_MASTER_KEY:-}" && ! -f "${master_key_file}" ]]; then
    mkdir -p "$(dirname "${master_key_file}")"
    "${NODE_BIN}" -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))" > "${master_key_file}" \
      || { echo "[install] rust: master key provisioning failed" >&2; return 1; }
    chmod 600 "${master_key_file}"
    echo "[install] rust: provisioned master key file ${master_key_file} (0600)."
  fi
  if [[ -z "${FRIDAY_MASTER_KEY:-}" && ! -r "${master_key_file}" ]]; then
    echo "[install] rust: no master key (FRIDAY_MASTER_KEY unset AND ${master_key_file} absent) — skipping (server would fail closed)." >&2
    return 1
  fi

  # (port check) The supervised server is the SINGLE owner of the loopback port. Bootout any
  # prior instance FIRST so a re-install frees its own port, then require the port be free +
  # distinct from the TS hub port (3141 when the hub plist sets no FRIDAY_PORT).
  launchctl bootout "gui/${UID}" "${RUST_PLIST_PATH}" >/dev/null 2>&1 || true
  if (( RUST_WS_PORT == 3141 )); then
    echo "[install] rust: chosen WS port ${RUST_WS_PORT} collides with the TS hub default (3141) — skipping." >&2
    return 1
  fi
  if command -v lsof >/dev/null 2>&1; then
    if lsof -nP -iTCP:"${RUST_WS_PORT}" -sTCP:LISTEN >/dev/null 2>&1; then
      echo "[install] rust: WS port ${RUST_WS_PORT} is already in use — skipping (set FRIDAY_HUB_AGENT_RUN_WS_PORT to a free port)." >&2
      return 1
    fi
  fi

  # (fill plist) from the payload's template into the live LaunchAgents dir.
  sed \
    -e "s/__RUST_SERVER_BIN__/$(rust_sed_escape "${server_bin}")/g" \
    -e "s/__WORKSPACE_ROOT__/$(rust_sed_escape "${RUST_WORKSPACE_ROOT}")/g" \
    -e "s/__HUB_DB_PATH__/$(rust_sed_escape "${RUST_HUB_DB_PATH}")/g" \
    -e "s/__WS_PORT__/$(rust_sed_escape "${RUST_WS_PORT}")/g" \
    -e "s/__OWNER_PRINCIPAL__/$(rust_sed_escape "${RUST_OWNER_PRINCIPAL}")/g" \
    -e "s/__STORE_DIR__/$(rust_sed_escape "${RUST_STORE_DIR}")/g" \
    -e "s/__LOG_DIR__/$(rust_sed_escape "${LOG_DIR}")/g" \
    -e "s/__REPO_DIR__/$(rust_sed_escape "${REPO_DIR}")/g" \
    "${RUST_PLIST_TEMPLATE}" > "${RUST_PLIST_PATH}" \
    || { echo "[install] rust: filling plist failed" >&2; return 1; }
  if grep -q '__[A-Z_]*__' "${RUST_PLIST_PATH}"; then
    echo "[install] rust: filled plist still has placeholders:" >&2
    grep -o '__[A-Z_]*__' "${RUST_PLIST_PATH}" | sort -u >&2
    rm -f "${RUST_PLIST_PATH}"
    return 1
  fi

  # (plutil -lint)
  if command -v plutil >/dev/null 2>&1; then
    if ! plutil -lint "${RUST_PLIST_PATH}" >/dev/null; then
      plutil -lint "${RUST_PLIST_PATH}" >&2 || true
      rm -f "${RUST_PLIST_PATH}"
      echo "[install] rust: plutil -lint failed on filled plist" >&2
      return 1
    fi
  fi

  # (enroll) THIS host's client pubkey into the SAME store-dir the plist pins. Reads the
  # master key (env/file); idempotent (re-enroll REPLACES, never appends).
  if ! "${enroll_bin}" --store-dir "${RUST_STORE_DIR}" >/dev/null; then
    echo "[install] rust: hub_agent_run_enroll failed (store-dir ${RUST_STORE_DIR}) — skipping bootstrap." >&2
    return 1
  fi

  # (launchctl bootstrap)
  if [[ "${KICKSTART}" == "true" ]]; then
    launchctl enable "gui/${UID}/${RUST_LABEL}" >/dev/null 2>&1 || true
    if ! launchctl bootstrap "gui/${UID}" "${RUST_PLIST_PATH}"; then
      echo "[install] rust: launchctl bootstrap failed" >&2
      return 1
    fi
    launchctl kickstart -k "gui/${UID}/${RUST_LABEL}" >/dev/null 2>&1 || true
  fi

  echo "[install] rust: installed ${RUST_LABEL}"
  echo "[install] rust:   plist    ${RUST_PLIST_PATH}"
  echo "[install] rust:   server   ${server_bin}  (loopback 127.0.0.1:${RUST_WS_PORT})"
  echo "[install] rust:   store    ${RUST_STORE_DIR}   (enrolled)"
  echo "[install] rust:   hub DB   ${RUST_HUB_DB_PATH}"
  echo "[install] rust:   owner    ${RUST_OWNER_PRINCIPAL}   (MUST equal the TS hub's authenticated principal, or dispatch is refused fail-closed)"
  echo "[install] rust: NOTE end-to-end serving also requires the TS hub + this server to share the SAME master key (clean install: ${master_key_file}); a keychain-held hub key must be aligned to it."
  return 0
}

if [[ "${RUST_AGENT_ENABLED}" == "true" ]]; then
  if install_rust_agent_run_ws_server; then
    echo "[install] Rust agent-run WS server installed (4th launch agent)."
  else
    echo "[install] WARNING: Rust agent-run WS server NOT installed (see above); the base agents are unaffected." >&2
  fi
else
  echo "[install] Rust agent-run WS server payload not found — skipped (packaged release installs stage it under rust-agent-run/; set FRIDAY_INSTALL_RUST_AGENT_RUN=1 for a built dev tree)."
fi

echo "[install] installed launch agents:"
echo "[install]   ${HUB_PLIST_PATH}"
echo "[install]   ${COMPANION_PLIST_PATH}"
echo "[install]   ${UI_PLIST_PATH}"
if [[ "${RUST_AGENT_ENABLED}" == "true" && -f "${RUST_PLIST_PATH}" ]]; then
  echo "[install]   ${RUST_PLIST_PATH}"
  echo "[install] labels: ${HUB_LABEL}, ${COMPANION_LABEL}, ${UI_LABEL}, ${RUST_LABEL}"
else
  echo "[install] labels: ${HUB_LABEL}, ${COMPANION_LABEL}, ${UI_LABEL}"
fi
echo "[install] logs: ${LOG_DIR}"
