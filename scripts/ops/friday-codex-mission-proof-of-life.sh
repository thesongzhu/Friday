#!/usr/bin/env bash
#
# friday-codex-mission-proof-of-life.sh
# -------------------------------------
# Operator-run proof for the live Codex mission-intake path.
#
# What this does:
#   1. Prompts locally for the Friday local passphrase (hidden; never echoed).
#   2. Logs in to the loopback TS hub and captures a bearer in memory only.
#   3. POSTs one Codex-targeted Mission Spine intake:
#        lane="codex", targetProviderOrAgent="codex".
#   4. Polls the live Rust hub DB read-only for evidence that the fire-and-forget
#      auto-dispatch reached the Codex observe-wrapper path.
#
# Preflight:
#   Set FRIDAY_CODEX_MISSION_PROOF_PREFLIGHT_ONLY=1 to check local readiness
#   without reading a passphrase, logging in, creating traffic, or spending quota.
#
# Truth boundary:
#   PASS here is one operator-triggered Codex mission proof. It is NOT D8, NOT a
#   20-session soak, and NOT GO. It is a local operator proof surface.
#
# Secret hygiene:
#   - The passphrase is read with `read -rs` by default, or from stdin only when
#     FRIDAY_CODEX_MISSION_PROOF_PASSPHRASE_STDIN=1 is set by a local wrapper.
#   - It is streamed to curl via stdin, then unset.
#   - The bearer is stored only in a shell variable and never printed.
#   - The DB is opened read-only.
#
set -euo pipefail

readonly TS_HUB="${FRIDAY_TS_HUB_URL:-http://127.0.0.1:3141}"
readonly RUST_HUB_DB="${FRIDAY_HUB_AGENT_RUN_DB_PATH:-/Users/jarvis/Library/Application Support/Friday/state/rust-hub.sqlite}"
readonly OWNER_PRINCIPAL="${FRIDAY_CODEX_MISSION_PROOF_OWNER:-admin-001}"
readonly TIMEOUT_SEC="${FRIDAY_CODEX_MISSION_PROOF_TIMEOUT_SEC:-300}"
readonly DEFAULT_CODEX_APP_SERVER_TIMEOUT_MS=300000
readonly CODEX_MISSION_DISPATCH_TIMEOUT_MS=300000
readonly POLL_INTERVAL_SEC="${FRIDAY_CODEX_MISSION_PROOF_POLL_INTERVAL_SEC:-3}"
readonly PASSPHRASE_STDIN="${FRIDAY_CODEX_MISSION_PROOF_PASSPHRASE_STDIN:-0}"
readonly PREFLIGHT_ONLY="${FRIDAY_CODEX_MISSION_PROOF_PREFLIGHT_ONLY:-0}"
readonly RUST_WS_LAUNCH_WRAPPER="${FRIDAY_RUST_AGENT_RUN_WS_WRAPPER:-/Users/jarvis/.friday/launchd/rust-agent-run-ws-server-run.sh}"
readonly RUST_WS_LAUNCH_PLIST="${FRIDAY_RUST_AGENT_RUN_WS_LAUNCH_PLIST:-/Users/jarvis/Library/LaunchAgents/com.friday.rust-agent-run-ws-server.plist}"
readonly RUST_WS_LAUNCH_LABEL="${FRIDAY_RUST_AGENT_RUN_WS_LAUNCH_LABEL:-com.friday.rust-agent-run-ws-server}"
readonly RUST_WS_LAUNCH_DOMAIN="${FRIDAY_RUST_AGENT_RUN_WS_LAUNCH_DOMAIN:-gui/$(id -u)}"
readonly RUST_WS_HOST="127.0.0.1"
readonly RUST_WS_PORT="48750"
readonly TS_HUB_LAUNCH_PLIST="${FRIDAY_TS_HUB_LAUNCH_PLIST:-/Users/jarvis/Library/LaunchAgents/com.friday.hub.plist}"
readonly TS_HUB_LAUNCH_LABEL="${FRIDAY_TS_HUB_LAUNCH_LABEL:-com.friday.hub}"
readonly TS_HUB_LAUNCH_DOMAIN="${FRIDAY_TS_HUB_LAUNCH_DOMAIN:-gui/$(id -u)}"
readonly CODEX_MODEL="gpt-5.5"
readonly EXPECTED_CODEX_CLI_VERSION="${FRIDAY_CODEX_MISSION_PROOF_CODEX_VERSION:-codex-cli 0.140.0}"
readonly RUN_KIND="${FRIDAY_CODEX_MISSION_PROOF_RUN_KIND:-proof}"
readonly SURFACE_KIND="${FRIDAY_CODEX_MISSION_PROOF_SURFACE_KIND:-mobile}"
readonly DELIVERY_ROUTE="${FRIDAY_CODEX_MISSION_PROOF_DELIVERY_ROUTE:-ops://codex-mission-proof-of-life}"
readonly MISSION_TITLE="${FRIDAY_CODEX_MISSION_PROOF_TITLE:-Codex proof token}"
readonly MISSION_INTENT="${FRIDAY_CODEX_MISSION_PROOF_INTENT:-What is the proof token? Answer exactly FRIDAY_CODEX_PROOF_OK.}"
readonly CAPABILITY_ID="${FRIDAY_CODEX_MISSION_PROOF_CAPABILITY_ID:-observe-wrapper.codex}"
readonly BODY_REF_PREFIX="friday://body/ops/codex-mission-proof-of-life"

SQLITE_BIN="$(command -v sqlite3 || true)"
if [ -z "${SQLITE_BIN}" ] && [ -x "/Users/jarvis/Library/Android/sdk/platform-tools/sqlite3" ]; then
  SQLITE_BIN="/Users/jarvis/Library/Android/sdk/platform-tools/sqlite3"
fi

for bin in curl jq node codex launchctl; do
  if ! command -v "${bin}" >/dev/null 2>&1; then
    echo "FATAL: required tool '${bin}' not found on PATH." >&2
    exit 3
  fi
done
if [ -z "${SQLITE_BIN}" ]; then
  echo "FATAL: no sqlite3 binary found on PATH." >&2
  exit 3
fi

tcp_port_ok() {
  local host="$1"
  local port="$2"
  (exec 3<>"/dev/tcp/${host}/${port}") >/dev/null 2>&1
}

if ! curl -sS --max-time 5 "${TS_HUB%/}/v1/health" >/dev/null 2>&1; then
  echo "FATAL: TS hub did not respond at ${TS_HUB%/}/v1/health." >&2
  exit 3
fi
if ! tcp_port_ok "${RUST_WS_HOST}" "${RUST_WS_PORT}"; then
  echo "FATAL: Rust sealed WS server did not accept a local TCP connection on ${RUST_WS_HOST}:${RUST_WS_PORT}." >&2
  exit 3
fi
if [ ! -r "${RUST_HUB_DB}" ]; then
  echo "FATAL: Rust hub DB is not readable at: ${RUST_HUB_DB}" >&2
  exit 3
fi

require_positive_int() {
  local name="$1"
  local value="$2"
  if [[ ! "${value}" =~ ^[1-9][0-9]*$ ]]; then
    echo "FATAL: ${name} must be a positive integer; got '${value}'." >&2
    exit 3
  fi
}

require_positive_int "FRIDAY_CODEX_MISSION_PROOF_TIMEOUT_SEC" "${TIMEOUT_SEC}"
require_positive_int "FRIDAY_CODEX_MISSION_PROOF_POLL_INTERVAL_SEC" "${POLL_INTERVAL_SEC}"
readonly PROOF_TIMEOUT_MS=$((TIMEOUT_SEC * 1000))
REQUIRED_CODEX_APP_SERVER_TIMEOUT_MS="${CODEX_MISSION_DISPATCH_TIMEOUT_MS}"
if [ "${PROOF_TIMEOUT_MS}" -gt "${REQUIRED_CODEX_APP_SERVER_TIMEOUT_MS}" ]; then
  REQUIRED_CODEX_APP_SERVER_TIMEOUT_MS="${PROOF_TIMEOUT_MS}"
fi
CODEX_APP_SERVER_TIMEOUT_EFFECTIVE_SOURCE_SEEN=0
if [ "${PASSPHRASE_STDIN}" != "0" ] && [ "${PASSPHRASE_STDIN}" != "1" ]; then
  echo "FATAL: FRIDAY_CODEX_MISSION_PROOF_PASSPHRASE_STDIN must be 0 or 1; got '${PASSPHRASE_STDIN}'." >&2
  exit 3
fi
if [ "${PREFLIGHT_ONLY}" != "0" ] && [ "${PREFLIGHT_ONLY}" != "1" ]; then
  echo "FATAL: FRIDAY_CODEX_MISSION_PROOF_PREFLIGHT_ONLY must be 0 or 1; got '${PREFLIGHT_ONLY}'." >&2
  exit 3
fi
if [ "${POLL_INTERVAL_SEC}" -gt "${TIMEOUT_SEC}" ]; then
  echo "FATAL: poll interval cannot be greater than timeout." >&2
  exit 3
fi
case "${RUN_KIND}" in
  proof|organic) ;;
  *)
    echo "FATAL: FRIDAY_CODEX_MISSION_PROOF_RUN_KIND must be proof or organic; got '${RUN_KIND}'." >&2
    exit 3
    ;;
esac
case "${SURFACE_KIND}" in
  mobile|desktop) ;;
  *)
    echo "FATAL: FRIDAY_CODEX_MISSION_PROOF_SURFACE_KIND must be mobile or desktop; got '${SURFACE_KIND}'." >&2
    exit 3
    ;;
esac
case "${DELIVERY_ROUTE}" in
  ops://codex-mission-proof-of-life|ops://codex-organic-spawn) ;;
  *)
    echo "FATAL: FRIDAY_CODEX_MISSION_PROOF_DELIVERY_ROUTE is not an allowed local Codex launcher route: '${DELIVERY_ROUTE}'." >&2
    exit 3
    ;;
esac
if [ -z "${MISSION_INTENT}" ]; then
  echo "FATAL: FRIDAY_CODEX_MISSION_PROOF_INTENT must not be empty." >&2
  exit 3
fi
if [ ! -r "${RUST_WS_LAUNCH_WRAPPER}" ]; then
  echo "FATAL: Rust agent-run WS launch wrapper is not readable at: ${RUST_WS_LAUNCH_WRAPPER}" >&2
  exit 3
fi
if [ ! -r "${RUST_WS_LAUNCH_PLIST}" ]; then
  echo "FATAL: Rust agent-run WS LaunchAgent plist is not readable at: ${RUST_WS_LAUNCH_PLIST}" >&2
  exit 3
fi
if [ ! -r "${TS_HUB_LAUNCH_PLIST}" ]; then
  echo "FATAL: TS hub LaunchAgent plist is not readable at: ${TS_HUB_LAUNCH_PLIST}" >&2
  exit 3
fi
if [ ! -x "/usr/bin/plutil" ]; then
  echo "FATAL: required tool '/usr/bin/plutil' not found." >&2
  exit 3
fi

CODEX_BIN="$(command -v codex || true)"
CODEX_VERSION="$(codex --version 2>/dev/null || true)"
if [ -z "${CODEX_VERSION}" ]; then
  echo "FATAL: codex CLI did not return a version." >&2
  exit 3
fi
if [ "${CODEX_VERSION}" != "${EXPECTED_CODEX_CLI_VERSION}" ]; then
  echo "FATAL: codex CLI version mismatch; expected '${EXPECTED_CODEX_CLI_VERSION}', got '${CODEX_VERSION}'." >&2
  exit 3
fi

require_file_contains() {
  local file="$1"
  local needle="$2"
  local label="$3"
  if ! grep -Fq -- "${needle}" "${file}"; then
    echo "FATAL: ${label} missing from ${file}." >&2
    exit 3
  fi
}

require_file_contains "${RUST_WS_LAUNCH_WRAPPER}" 'export PATH="$HOME/.local/bin:$PATH"' "codex CLI PATH export"
require_file_contains "${RUST_WS_LAUNCH_WRAPPER}" "export FRIDAY_CODEX_ROUTE_ENABLED=1" "Codex route flag"
require_file_contains "${RUST_WS_LAUNCH_WRAPPER}" "export FRIDAY_OBSERVE_WRAPPER_ENABLED=1" "observe-wrapper flag"
require_file_contains "${RUST_WS_LAUNCH_WRAPPER}" "export FRIDAY_MISSION_BOUND_RUN=1" "mission-bound run flag"
require_file_contains "${RUST_WS_LAUNCH_WRAPPER}" "--validate-codex" "Rust server Codex validation flag"

rust_ws_export_value() {
  local key="$1"
  local line
  line="$(grep -E "^[[:space:]]*export[[:space:]]+${key}=" "${RUST_WS_LAUNCH_WRAPPER}" | tail -n1 || true)"
  if [ -z "${line}" ]; then
    return 1
  fi
  line="${line#*${key}=}"
  line="${line%%#*}"
  line="${line#"${line%%[![:space:]]*}"}"
  line="${line%"${line##*[![:space:]]}"}"
  line="${line%\"}"
  line="${line#\"}"
  line="${line%\'}"
  line="${line#\'}"
  printf '%s' "${line}"
}

require_codex_app_server_timeout() {
  local label="$1"
  local value="$2"
  if [[ ! "${value}" =~ ^[1-9][0-9]*$ ]]; then
    echo "FATAL: ${label} FRIDAY_CODEX_APP_SERVER_TIMEOUT_MS must be a literal positive millisecond value; got '${value}'." >&2
    exit 3
  fi
  if [ "${value}" -lt "${REQUIRED_CODEX_APP_SERVER_TIMEOUT_MS}" ]; then
    echo "FATAL: ${label} FRIDAY_CODEX_APP_SERVER_TIMEOUT_MS=${value}ms is shorter than required ${REQUIRED_CODEX_APP_SERVER_TIMEOUT_MS}ms." >&2
    exit 3
  fi
}

if CODEX_APP_SERVER_TIMEOUT_MS_OVERRIDE="$(rust_ws_export_value "FRIDAY_CODEX_APP_SERVER_TIMEOUT_MS")"; then
  require_codex_app_server_timeout "Rust WS launch wrapper" "${CODEX_APP_SERVER_TIMEOUT_MS_OVERRIDE}"
  CODEX_APP_SERVER_TIMEOUT_EFFECTIVE_SOURCE_SEEN=1
fi

plist_optional_env_value() {
  local plist="$1"
  local key="$2"
  /usr/bin/plutil -extract "EnvironmentVariables.${key}" raw -o - "${plist}" 2>/dev/null
}

plist_env_value() {
  local plist="$1"
  local key="$2"
  local label="$3"
  local value
  if ! value="$(plist_optional_env_value "${plist}" "${key}")"; then
    echo "FATAL: ${label} LaunchAgent plist is missing EnvironmentVariables.${key}." >&2
    exit 3
  fi
  printf '%s' "${value}"
}

require_plist_env_equals() {
  local plist="$1"
  local key="$2"
  local expected="$3"
  local label="$4"
  local actual
  actual="$(plist_env_value "${plist}" "${key}" "${label}")"
  if [ "${actual}" != "${expected}" ]; then
    echo "FATAL: ${label} mismatch in ${plist}; expected '${expected}', got '${actual}'." >&2
    exit 3
  fi
}

require_plist_path_contains() {
  local plist="$1"
  local key="$2"
  local required_path="$3"
  local label="$4"
  local actual
  actual="$(plist_env_value "${plist}" "${key}" "${label}")"
  case ":${actual}:" in
    *":${required_path}:"*) ;;
    *)
      echo "FATAL: ${label} missing '${required_path}' in ${plist}." >&2
      exit 3
      ;;
  esac
}

check_optional_plist_env_equals() {
  local plist="$1"
  local key="$2"
  local expected="$3"
  local label="$4"
  local actual
  if actual="$(plist_optional_env_value "${plist}" "${key}")"; then
    if [ "${actual}" != "${expected}" ]; then
      echo "FATAL: ${label} mismatch in ${plist}; expected '${expected}', got '${actual}'." >&2
      exit 3
    fi
  fi
}

check_optional_plist_path_contains() {
  local plist="$1"
  local key="$2"
  local required_path="$3"
  local label="$4"
  if plist_optional_env_value "${plist}" "${key}" >/dev/null; then
    require_plist_path_contains "${plist}" "${key}" "${required_path}" "${label}"
  fi
}

if RUST_WS_PLIST_CODEX_APP_SERVER_TIMEOUT_MS="$(plist_optional_env_value "${RUST_WS_LAUNCH_PLIST}" "FRIDAY_CODEX_APP_SERVER_TIMEOUT_MS")"; then
  require_codex_app_server_timeout "Rust WS LaunchAgent plist" "${RUST_WS_PLIST_CODEX_APP_SERVER_TIMEOUT_MS}"
fi

check_optional_plist_env_equals "${TS_HUB_LAUNCH_PLIST}" "FRIDAY_MISSION_AUTO_DISPATCH" "1" "TS hub mission auto-dispatch flag"
check_optional_plist_env_equals "${TS_HUB_LAUNCH_PLIST}" "FRIDAY_MISSION_SPINE_ROUTES_VIA_RUST" "1" "TS hub mission spine Rust route flag"
check_optional_plist_env_equals "${TS_HUB_LAUNCH_PLIST}" "FRIDAY_ROUTE_AGENT_RUN_VIA_RUST" "1" "TS hub agent-run Rust route flag"
check_optional_plist_env_equals "${TS_HUB_LAUNCH_PLIST}" "FRIDAY_HUB_AGENT_RUN_WS_PORT" "48750" "TS hub Rust agent-run WS port"
check_optional_plist_env_equals "${TS_HUB_LAUNCH_PLIST}" "FRIDAY_HUB_AGENT_RUN_DB_PATH" "${RUST_HUB_DB}" "TS hub Rust DB path"
check_optional_plist_path_contains "${TS_HUB_LAUNCH_PLIST}" "PATH" "/Users/jarvis/.local/bin" "TS hub PATH"
if TS_HUB_NODE_BIN="$(plist_optional_env_value "${TS_HUB_LAUNCH_PLIST}" "FRIDAY_NODE_BIN")"; then
  if [ ! -x "${TS_HUB_NODE_BIN}" ]; then
    echo "FATAL: TS hub FRIDAY_NODE_BIN is not executable at: ${TS_HUB_NODE_BIN}" >&2
    exit 3
  fi
fi

if ! RUST_WS_LAUNCHCTL_PRINT="$(launchctl print "${RUST_WS_LAUNCH_DOMAIN}/${RUST_WS_LAUNCH_LABEL}" 2>/dev/null)"; then
  echo "FATAL: live Rust WS LaunchAgent is not printable at ${RUST_WS_LAUNCH_DOMAIN}/${RUST_WS_LAUNCH_LABEL}." >&2
  exit 3
fi
if ! TS_HUB_LAUNCHCTL_PRINT="$(launchctl print "${TS_HUB_LAUNCH_DOMAIN}/${TS_HUB_LAUNCH_LABEL}" 2>/dev/null)"; then
  echo "FATAL: live TS hub LaunchAgent is not printable at ${TS_HUB_LAUNCH_DOMAIN}/${TS_HUB_LAUNCH_LABEL}." >&2
  exit 3
fi

launchctl_optional_env_value() {
  local print_body="$1"
  local key="$2"
  local value
  printf '%s\n' "${print_body}" | awk -v key="${key}" '
    $1 == "environment" && $2 == "=" && $3 == "{" {
      in_env = 1
      next
    }
    in_env && $1 == "}" {
      exit
    }
    in_env && $1 == key && $2 == "=>" {
      sub(/^[[:space:]]*[^[:space:]]+[[:space:]]+=>[[:space:]]*/, "")
      print
      found = 1
      exit
    }
    END {
      if (!found) {
        exit 1
      }
    }
  '
}

launchctl_env_value() {
  local print_body="$1"
  local key="$2"
  local label="$3"
  local value
  if ! value="$(launchctl_optional_env_value "${print_body}" "${key}")"; then
    echo "FATAL: live ${label} LaunchAgent environment is missing ${key}." >&2
    exit 3
  fi
  printf '%s' "${value}"
}

require_launchctl_env_equals() {
  local print_body="$1"
  local key="$2"
  local expected="$3"
  local label="$4"
  local actual
  actual="$(launchctl_env_value "${print_body}" "${key}" "${label}")"
  if [ "${actual}" != "${expected}" ]; then
    echo "FATAL: ${label} mismatch in live LaunchAgent; expected '${expected}', got '${actual}'." >&2
    exit 3
  fi
}

require_launchctl_path_contains() {
  local print_body="$1"
  local key="$2"
  local required_path="$3"
  local label="$4"
  local actual
  actual="$(launchctl_env_value "${print_body}" "${key}" "${label}")"
  case ":${actual}:" in
    *":${required_path}:"*) ;;
    *)
      echo "FATAL: ${label} missing '${required_path}' in live LaunchAgent." >&2
      exit 3
      ;;
  esac
}

if RUST_WS_RUNTIME_CODEX_APP_SERVER_TIMEOUT_MS="$(launchctl_optional_env_value "${RUST_WS_LAUNCHCTL_PRINT}" "FRIDAY_CODEX_APP_SERVER_TIMEOUT_MS")"; then
  require_codex_app_server_timeout "live Rust WS LaunchAgent" "${RUST_WS_RUNTIME_CODEX_APP_SERVER_TIMEOUT_MS}"
  CODEX_APP_SERVER_TIMEOUT_EFFECTIVE_SOURCE_SEEN=1
fi
if [ "${CODEX_APP_SERVER_TIMEOUT_EFFECTIVE_SOURCE_SEEN}" -eq 0 ]; then
  require_codex_app_server_timeout "Rust default" "${DEFAULT_CODEX_APP_SERVER_TIMEOUT_MS}"
fi

require_launchctl_env_equals "${TS_HUB_LAUNCHCTL_PRINT}" "FRIDAY_MISSION_AUTO_DISPATCH" "1" "live TS hub mission auto-dispatch flag"
require_launchctl_env_equals "${TS_HUB_LAUNCHCTL_PRINT}" "FRIDAY_MISSION_SPINE_ROUTES_VIA_RUST" "1" "live TS hub mission spine Rust route flag"
require_launchctl_env_equals "${TS_HUB_LAUNCHCTL_PRINT}" "FRIDAY_ROUTE_AGENT_RUN_VIA_RUST" "1" "live TS hub agent-run Rust route flag"
require_launchctl_env_equals "${TS_HUB_LAUNCHCTL_PRINT}" "FRIDAY_HUB_AGENT_RUN_WS_PORT" "48750" "live TS hub Rust agent-run WS port"
require_launchctl_env_equals "${TS_HUB_LAUNCHCTL_PRINT}" "FRIDAY_HUB_AGENT_RUN_DB_PATH" "${RUST_HUB_DB}" "live TS hub Rust DB path"
require_launchctl_path_contains "${TS_HUB_LAUNCHCTL_PRINT}" "PATH" "/Users/jarvis/.local/bin" "live TS hub PATH"
TS_HUB_RUNTIME_NODE_BIN="$(launchctl_env_value "${TS_HUB_LAUNCHCTL_PRINT}" "FRIDAY_NODE_BIN" "TS hub")"
if [ ! -x "${TS_HUB_RUNTIME_NODE_BIN}" ]; then
  echo "FATAL: live TS hub FRIDAY_NODE_BIN is not executable at: ${TS_HUB_RUNTIME_NODE_BIN}" >&2
  exit 3
fi

now_ms() {
  node -e 'process.stdout.write(String(Date.now()))'
}

new_id() {
  node -e 'process.stdout.write((globalThis.crypto?.randomUUID?.() ?? (`id-${Date.now()}-${Math.random().toString(16).slice(2)}`)).toLowerCase())'
}

sql_scalar() {
  local sql="$1"
  local value
  if ! value="$("${SQLITE_BIN}" -readonly "file:${RUST_HUB_DB}?mode=ro" "${sql}" 2>/dev/null)"; then
    echo "FATAL: SQLite scalar query failed." >&2
    exit 6
  fi
  printf '%s' "${value}"
}

sql_count() {
  local label="$1"
  local sql="$2"
  local value
  value="$(sql_scalar "${sql}")"
  if [[ ! "${value}" =~ ^[0-9]+$ ]]; then
    echo "FATAL: expected numeric SQLite count for ${label}; got '${value:-<empty>}'." >&2
    exit 6
  fi
  printf '%s' "${value}"
}

curl_config_escape() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

curl_bearer_json() {
  local method="$1"
  local url="$2"
  local max_time="$3"
  local body="$4"
  {
    printf 'silent\n'
    printf 'show-error\n'
    printf 'max-time = %s\n' "${max_time}"
    printf 'request = "%s"\n' "$(curl_config_escape "${method}")"
    printf 'url = "%s"\n' "$(curl_config_escape "${url}")"
    printf 'header = "Content-Type: application/json"\n'
    printf 'header = "Authorization: Bearer %s"\n' "$(curl_config_escape "${TOKEN}")"
    printf 'data = "%s"\n' "$(curl_config_escape "${body}")"
    printf 'write-out = "\\n%%{http_code}"\n'
  } | curl --config - 2>/dev/null
}

require_schema_column() {
  local table="$1"
  local column="$2"
  local count
  count="$(sql_count "schema column ${table}.${column}" "SELECT COUNT(*) FROM pragma_table_info('${table}') WHERE name='${column}';")"
  if [ "${count}" -ne 1 ]; then
    echo "FATAL: Rust hub DB schema is missing required column ${table}.${column}." >&2
    exit 3
  fi
}

sql_json() {
  local sql="$1"
  "${SQLITE_BIN}" -readonly -json "file:${RUST_HUB_DB}?mode=ro" "${sql}" 2>/dev/null || printf '[]'
}

require_schema_column "token_ledger" "ledger_id"
require_schema_column "token_ledger" "provider_kind"
require_schema_column "token_ledger" "model"
require_schema_column "token_ledger" "run_id"
require_schema_column "provider_session_event" "provider"
require_schema_column "provider_session_event" "token_ledger_ref"
require_schema_column "provider_session_event" "observed_at"
require_schema_column "work_item" "work_item_id"
require_schema_column "work_item" "mission_id"
require_schema_column "work_item" "lane"
require_schema_column "work_item" "target_provider_or_agent"
require_schema_column "work_item" "proof_receipts"
require_schema_column "work_item" "status"
require_schema_column "work_item" "updated_at_ms"
require_schema_column "mission" "mission_id"
require_schema_column "mission" "friday_conversation_id"
require_schema_column "mission" "created_at_ms"
require_schema_column "surface_thread" "surface_thread_id"
require_schema_column "surface_thread" "friday_conversation_id"
require_schema_column "surface_thread" "mission_id"
require_schema_column "surface_thread" "surface_kind"
require_schema_column "surface_thread" "delivery_route"
require_schema_column "surface_thread" "created_at_ms"
require_schema_column "workspace_claim" "claim_id"
require_schema_column "workspace_claim" "work_item_id"
require_schema_column "workspace_claim" "claim_kind"
require_schema_column "process_observation" "process_kind"
require_schema_column "process_observation" "ownership_status"
require_schema_column "process_observation" "observed_at_ms"
require_schema_column "process_observation" "matched_claim_id"
require_schema_column "process_observation" "port_bindings"

if [ "${PREFLIGHT_ONLY}" = "1" ]; then
  echo "Codex Mission proof preflight OK."
  echo "  TS hub: ${TS_HUB}"
  echo "  Rust DB: ${RUST_HUB_DB}"
  echo "  schemaReady: ok"
  echo "  codexCli: ok (${CODEX_BIN}; ${CODEX_VERSION})"
  echo "  rustWsLaunchWrapper: ok (${RUST_WS_LAUNCH_WRAPPER})"
  echo "  rustWsPort: ok (${RUST_WS_HOST}:${RUST_WS_PORT})"
  echo "  tsHubLaunchPlist: ok (${TS_HUB_LAUNCH_PLIST})"
  echo "  tsHubLaunchFlags: ok"
  echo "  tsHubLaunchRuntime: ok (${TS_HUB_LAUNCH_DOMAIN}/${TS_HUB_LAUNCH_LABEL})"
  if curl -sS --max-time 5 "${TS_HUB%/}/v1/health" >/dev/null 2>&1; then
    echo "  tsHealth: ok"
  else
    echo "  tsHealth: not-ok"
    exit 3
  fi
  echo "  codexLedgerRows: $(sql_count "preflight codex ledger" "SELECT COUNT(*) FROM token_ledger WHERE provider_kind='codex';")"
  echo "  codexEventRows: $(sql_count "preflight codex events" "SELECT COUNT(*) FROM provider_session_event WHERE provider='codex';")"
  echo "  codexWorkItems: $(sql_count "preflight codex work items" "SELECT COUNT(*) FROM work_item WHERE lane='codex' OR target_provider_or_agent='codex';")"
  echo "Truth: preflight creates no traffic and proves only local readiness, not Codex proof / D8 / GO."
  exit 0
fi

readonly RUN_TAG="$(new_id)"
if [ "${RUN_KIND}" = "organic" ]; then
  readonly ID_PREFIX="codex-organic"
else
  readonly ID_PREFIX="codex-proof"
fi
readonly FRIDAY_CONVERSATION_ID="fconv_${ID_PREFIX//-/_}_${RUN_TAG//-/_}"
readonly MISSION_ID="${ID_PREFIX}-mission-${RUN_TAG}"
readonly WORK_ITEM_ID="${ID_PREFIX}-work-${RUN_TAG}"
readonly SURFACE_THREAD_ID="${ID_PREFIX}-surface-${RUN_TAG}"
readonly BODY_REF="${FRIDAY_CODEX_MISSION_PROOF_BODY_REF:-${BODY_REF_PREFIX}/${WORK_ITEM_ID}}"

echo "Codex Mission ${RUN_KIND} starting."
echo "  TS hub: ${TS_HUB}"
echo "  Rust DB: ${RUST_HUB_DB}"
echo "  missionId: ${MISSION_ID}"
echo "  workItemId: ${WORK_ITEM_ID}"
echo

if [ "${PASSPHRASE_STDIN}" = "1" ]; then
  if ! IFS= read -r PASSPHRASE; then
    echo "FATAL: failed to read passphrase from stdin." >&2
    exit 4
  fi
else
  printf 'Enter Friday local passphrase (input hidden): ' >&2
  read -rs PASSPHRASE
  printf '\n' >&2
fi
if [ -z "${PASSPHRASE}" ]; then
  echo "FATAL: empty passphrase." >&2
  exit 4
fi

LOGIN_RAW="$(
  printf '%s' "${PASSPHRASE}" \
    | jq -Rs '{localPassphrase: .}' \
    | curl -sS --max-time 30 -w $'\n%{http_code}' \
        -X POST "${TS_HUB%/}/v1/auth/login" \
        -H 'Content-Type: application/json' \
        --data @- 2>/dev/null
)" || true
unset PASSPHRASE

LOGIN_CODE="$(printf '%s' "${LOGIN_RAW}" | tail -n1)"
LOGIN_BODY="$(printf '%s' "${LOGIN_RAW}" | sed '$d')"
unset LOGIN_RAW
if [ "${LOGIN_CODE}" != "200" ]; then
  echo "FAIL: login returned HTTP ${LOGIN_CODE}; passphrase was not shown." >&2
  exit 4
fi

TOKEN="$(printf '%s' "${LOGIN_BODY}" | jq -r '.data.accessToken // .accessToken // empty')"
unset LOGIN_BODY
if [ -z "${TOKEN}" ]; then
  echo "FAIL: login succeeded but response had no accessToken." >&2
  exit 4
fi
echo "Step 1 OK: authenticated (token captured, not shown)."

BASELINE_CODEX_LEDGER="$(sql_count "baseline codex ledger" "SELECT COUNT(*) FROM token_ledger WHERE provider_kind='codex' AND model='${CODEX_MODEL}' AND fallback=0 AND total_tokens>0;")"
BASELINE_CODEX_EVENTS="$(sql_count "baseline codex events" "SELECT COUNT(*) FROM provider_session_event WHERE provider='codex';")"
BASELINE_CODEX_PROCESS="$(sql_count "baseline codex process observations" "SELECT COUNT(*) FROM process_observation WHERE process_kind='codex_app_server';")"
readonly STARTED_AT_MS="$(now_ms)"

INTAKE_BODY="$(jq -nc \
  --arg conv "${FRIDAY_CONVERSATION_ID}" \
  --arg owner "${OWNER_PRINCIPAL}" \
  --arg surface "${SURFACE_THREAD_ID}" \
  --arg mission "${MISSION_ID}" \
  --arg work "${WORK_ITEM_ID}" \
  --arg surfaceKind "${SURFACE_KIND}" \
  --arg deliveryRoute "${DELIVERY_ROUTE}" \
  --arg title "${MISSION_TITLE}" \
  --arg intent "${MISSION_INTENT}" \
  --arg capability "${CAPABILITY_ID}" \
  --arg bodyRef "${BODY_REF}" \
  '{
    fridayConversationId: $conv,
    ownerPrincipal: $owner,
    surfaceThreadId: $surface,
    surfaceKind: $surfaceKind,
    deliveryRoute: $deliveryRoute,
    visibilityPolicy: "compact",
    missionId: $mission,
    workItemId: $work,
    title: $title,
    intent: $intent,
    lane: "codex",
    targetProviderOrAgent: "codex",
    capabilityId: $capability,
    bodyRef: $bodyRef,
    includesSensitiveContext: false
  }')"

echo "Step 2: POST /v1/mission-spine/intake (Codex target)..."
INTAKE_RAW="$(
  curl_bearer_json "POST" "${TS_HUB%/}/v1/mission-spine/intake" "60" "${INTAKE_BODY}"
)" || true
unset TOKEN

INTAKE_CODE="$(printf '%s' "${INTAKE_RAW}" | tail -n1)"
INTAKE_JSON="$(printf '%s' "${INTAKE_RAW}" | sed '$d')"
unset INTAKE_RAW
INTAKE_STATUS="$(printf '%s' "${INTAKE_JSON}" | jq -r '.data.result.status // .result.status // empty' 2>/dev/null || true)"
INTAKE_CREATED="$(printf '%s' "${INTAKE_JSON}" | jq -r '.data.result.createdOrReady // .result.createdOrReady // empty' 2>/dev/null || true)"
echo "Step 2: HTTP ${INTAKE_CODE} status=${INTAKE_STATUS:-<none>} createdOrReady=${INTAKE_CREATED:-<none>}"

if [ "${INTAKE_CODE}" != "200" ]; then
  ERR_CODE="$(printf '%s' "${INTAKE_JSON}" | jq -r '.error.code // .data.error.code // empty' 2>/dev/null || true)"
  echo "FAIL: intake did not return HTTP 200. errorCode=${ERR_CODE:-<none>}" >&2
  exit 5
fi

deadline=$(( $(date +%s) + TIMEOUT_SEC ))
pass_reason=""
while [ "$(date +%s)" -le "${deadline}" ]; do
  CODEX_LEDGER_NEW="$(sql_count "codex ledger since start" "SELECT COUNT(*) FROM token_ledger WHERE provider_kind='codex' AND model='${CODEX_MODEL}' AND fallback=0 AND total_tokens>0 AND created_at >= ${STARTED_AT_MS};")"
  CODEX_EVENTS_NEW="$(sql_count "codex events since start" "SELECT COUNT(*) FROM provider_session_event WHERE provider='codex' AND observed_at >= ${STARTED_AT_MS};")"
  CODEX_LEDGER_LINKED_EVENTS_NEW="$(sql_count "codex linked events since start" "SELECT COUNT(*) FROM provider_session_event WHERE provider='codex' AND observed_at >= ${STARTED_AT_MS} AND COALESCE(token_ledger_ref,'') <> '';")"
  CODEX_SESSION_LINKS_NEW="$(sql_count "codex session links since start" "SELECT COUNT(*) FROM provider_session_link WHERE provider='codex' AND sync_mode='provider_app_server_local' AND COALESCE(last_provider_seen_at,0) >= ${STARTED_AT_MS};")"
  CODEX_PROCESS_NEW="$(sql_count "claimed codex process observations since start" "SELECT COUNT(*) FROM process_observation WHERE process_kind='codex_app_server' AND ownership_status='friday_owned_claimed' AND observed_at_ms >= ${STARTED_AT_MS};")"
  WORK_ITEM_PRESENT="$(sql_count "this codex work item" "SELECT COUNT(*) FROM work_item WHERE work_item_id='${WORK_ITEM_ID}' AND lane='codex' AND COALESCE(target_provider_or_agent,'')='codex';")"
  WORK_ITEM_COMPLETED="$(sql_count "this completed codex work item" "SELECT COUNT(*) FROM work_item WHERE work_item_id='${WORK_ITEM_ID}' AND lane='codex' AND COALESCE(target_provider_or_agent,'')='codex' AND status='completed_with_proof';")"
  WORK_ITEM_LINKED_PROOF="$(sql_count "this completed codex work item with linked ledger proof" "
    SELECT COUNT(DISTINCT ledger.run_id)
    FROM work_item w
    JOIN json_each(w.proof_receipts) proof
      ON proof.value IS NOT NULL
    JOIN token_ledger ledger
      ON proof.value = 'friday://agent-run/' || ledger.run_id
     AND ledger.provider_kind = 'codex'
     AND ledger.model = '${CODEX_MODEL}'
     AND ledger.fallback = 0
     AND ledger.total_tokens > 0
     AND ledger.created_at >= ${STARTED_AT_MS}
    JOIN provider_session_event event
      ON event.provider = 'codex'
     AND event.token_ledger_ref = ledger.ledger_id
     AND event.observed_at >= ${STARTED_AT_MS}
    WHERE w.work_item_id = '${WORK_ITEM_ID}'
      AND w.lane = 'codex'
      AND COALESCE(w.target_provider_or_agent,'') = 'codex'
      AND w.status = 'completed_with_proof'
      AND w.updated_at_ms >= ledger.created_at;
  ")"
  WORK_ITEM_CLAIM_BOUND_PROCESS_PROOF="$(sql_count "this completed codex work item with claim-bound process proof" "
    WITH matching_proofs AS (
      SELECT DISTINCT
        w.work_item_id AS work_item_id,
        event.friday_session_id AS friday_session_id,
        CASE
          WHEN COALESCE(link.last_provider_seen_at,0) >= event.observed_at
            THEN COALESCE(link.last_provider_seen_at,0)
          ELSE event.observed_at
        END AS seen_at,
        ledger.created_at AS ledger_created_at
      FROM work_item w
      JOIN json_each(w.proof_receipts) proof
        ON proof.value IS NOT NULL
      JOIN token_ledger ledger
        ON proof.value = 'friday://agent-run/' || ledger.run_id
       AND ledger.provider_kind = 'codex'
       AND ledger.model = '${CODEX_MODEL}'
       AND ledger.fallback = 0
       AND ledger.total_tokens > 0
       AND ledger.created_at >= ${STARTED_AT_MS}
      JOIN provider_session_event event
        ON event.provider = 'codex'
       AND event.token_ledger_ref = ledger.ledger_id
       AND event.observed_at >= ${STARTED_AT_MS}
      JOIN provider_session_link link
        ON link.provider = event.provider
       AND link.friday_session_id = event.friday_session_id
       AND link.sync_mode = 'provider_app_server_local'
       AND COALESCE(link.last_provider_seen_at,0) >= ${STARTED_AT_MS}
      WHERE w.work_item_id = '${WORK_ITEM_ID}'
        AND w.lane = 'codex'
        AND COALESCE(w.target_provider_or_agent,'') = 'codex'
        AND w.status = 'completed_with_proof'
        AND w.updated_at_ms >= ledger.created_at
    )
    SELECT COUNT(DISTINCT p.friday_session_id)
    FROM matching_proofs p
    JOIN workspace_claim claim
      ON claim.work_item_id = p.work_item_id
     AND claim.claim_kind IN ('process','provider_session')
    JOIN process_observation observation
      ON observation.matched_claim_id = claim.claim_id
     AND observation.process_kind = 'codex_app_server'
     AND observation.ownership_status = 'friday_owned_claimed'
     AND observation.port_bindings LIKE '%\"friday://provider-session/' || p.friday_session_id || '\"%'
     AND observation.observed_at_ms >= ${STARTED_AT_MS}
     AND observation.observed_at_ms <= p.seen_at;
  ")"
  WORK_ITEM_SURFACE_BOUND_PROOF="$(sql_count "this completed codex work item with bound surface thread" "
    SELECT COUNT(DISTINCT surface.surface_thread_id)
    FROM work_item w
    JOIN mission m
      ON m.mission_id = w.mission_id
     AND m.mission_id = '${MISSION_ID}'
     AND m.friday_conversation_id = '${FRIDAY_CONVERSATION_ID}'
     AND m.created_at_ms >= ${STARTED_AT_MS}
     AND m.created_at_ms <= w.updated_at_ms
    JOIN surface_thread surface
      ON surface.surface_thread_id = '${SURFACE_THREAD_ID}'
     AND surface.mission_id = w.mission_id
     AND surface.friday_conversation_id = m.friday_conversation_id
     AND surface.surface_kind = '${SURFACE_KIND}'
     AND surface.delivery_route = '${DELIVERY_ROUTE}'
     AND surface.created_at_ms >= ${STARTED_AT_MS}
     AND surface.created_at_ms <= w.updated_at_ms
    WHERE w.work_item_id = '${WORK_ITEM_ID}'
      AND w.mission_id = '${MISSION_ID}'
      AND w.lane = 'codex'
      AND COALESCE(w.target_provider_or_agent,'') = 'codex'
      AND w.status = 'completed_with_proof';
  ")"
  UNPROVED_LINKED_SESSION_RUNS="$(sql_count "codex ledger-linked session runs without completed WorkItem proof" "
    WITH linked_runs AS (
      SELECT
        event.friday_session_id AS friday_session_id,
        ledger.run_id AS run_id,
        MAX(ledger.created_at) AS ledger_created_at
      FROM provider_session_link link
      JOIN provider_session_event event
        ON event.friday_session_id = link.friday_session_id
       AND event.provider = link.provider
      JOIN token_ledger ledger
        ON ledger.ledger_id = event.token_ledger_ref
      WHERE link.provider = 'codex'
        AND link.sync_mode = 'provider_app_server_local'
        AND COALESCE(link.last_provider_seen_at,0) >= ${STARTED_AT_MS}
        AND event.observed_at >= ${STARTED_AT_MS}
        AND COALESCE(event.token_ledger_ref,'') <> ''
        AND COALESCE(ledger.run_id,'') <> ''
        AND ledger.provider_kind = 'codex'
        AND ledger.model = '${CODEX_MODEL}'
        AND ledger.fallback = 0
        AND ledger.total_tokens > 0
      GROUP BY event.friday_session_id, ledger.run_id
    )
    SELECT COUNT(*)
    FROM linked_runs r
    WHERE NOT EXISTS (
      SELECT 1
      FROM work_item w
      JOIN json_each(w.proof_receipts) proof
        ON proof.value = 'friday://agent-run/' || r.run_id
      WHERE (w.lane = 'codex' OR w.target_provider_or_agent = 'codex')
        AND w.status = 'completed_with_proof'
        AND w.updated_at_ms >= ${STARTED_AT_MS}
        AND w.updated_at_ms >= r.ledger_created_at
    );
  ")"
  WORK_STATUS="$(sql_scalar "SELECT COALESCE(status, '') FROM work_item WHERE work_item_id='${WORK_ITEM_ID}' LIMIT 1;")"

  if [ "${WORK_ITEM_PRESENT}" -gt 0 ] && [ "${CODEX_LEDGER_NEW}" -gt 0 ] && [ "${CODEX_EVENTS_NEW}" -gt 0 ] && [ "${CODEX_LEDGER_LINKED_EVENTS_NEW}" -gt 0 ]; then
    pass_reason="this Codex work item + codex ledger + provider_session_event + token_ledger_ref observed"
    if [ "${WORK_ITEM_LINKED_PROOF}" -gt 0 ] \
      && [ "${WORK_ITEM_CLAIM_BOUND_PROCESS_PROOF}" -gt 0 ] \
      && [ "${WORK_ITEM_SURFACE_BOUND_PROOF}" -gt 0 ] \
      && [ "${UNPROVED_LINKED_SESSION_RUNS}" -eq 0 ]; then
      break
    fi
  fi

  printf 'Polling: workItem=%s workCompleted=%s linkedProof=%s claimBoundProcess=%s surfaceBoundProof=%s unprovedRuns=%s ledger=%s events=%s linkedEvents=%s sessionLinks=%s claimedProcess=%s workStatus=%s\n' \
    "${WORK_ITEM_PRESENT}" "${WORK_ITEM_COMPLETED}" "${WORK_ITEM_LINKED_PROOF}" \
    "${WORK_ITEM_CLAIM_BOUND_PROCESS_PROOF:-0}" "${WORK_ITEM_SURFACE_BOUND_PROOF:-0}" \
    "${UNPROVED_LINKED_SESSION_RUNS:-0}" \
    "${CODEX_LEDGER_NEW}" "${CODEX_EVENTS_NEW}" "${CODEX_LEDGER_LINKED_EVENTS_NEW}" \
    "${CODEX_SESSION_LINKS_NEW}" "${CODEX_PROCESS_NEW}" "${WORK_STATUS:-<none>}"
  sleep "${POLL_INTERVAL_SEC}"
done

echo
echo "----------------------------------------------"
echo "Baseline counts: codexLedger=${BASELINE_CODEX_LEDGER} codexEvents=${BASELINE_CODEX_EVENTS} codexProcess=${BASELINE_CODEX_PROCESS}"
echo "Mission: ${MISSION_ID}"
echo "Work item: ${WORK_ITEM_ID}"
echo "Started at ms: ${STARTED_AT_MS}"
echo
echo "Newest Codex token_ledger rows since start:"
sql_json "SELECT ledger_id, run_id, session_id, provider_kind, model, total_tokens, fallback, datetime(created_at/1000,'unixepoch') AS created_at_utc FROM token_ledger WHERE provider_kind='codex' AND created_at >= ${STARTED_AT_MS} ORDER BY created_at DESC LIMIT 5;"
echo
echo "Newest Codex provider_session_link rows since start:"
sql_json "SELECT friday_session_id, provider, sync_mode, external_thread_id, truth_label, datetime(last_provider_seen_at/1000,'unixepoch') AS last_seen_utc FROM provider_session_link WHERE provider='codex' AND COALESCE(last_provider_seen_at,0) >= ${STARTED_AT_MS} ORDER BY last_provider_seen_at DESC LIMIT 5;"
echo
echo "Newest Codex provider_session_event rows since start:"
sql_json "SELECT friday_session_id, provider_event_id, event_kind, transcript_item_kind, token_ledger_ref, datetime(observed_at/1000,'unixepoch') AS observed_at_utc FROM provider_session_event WHERE provider='codex' AND observed_at >= ${STARTED_AT_MS} ORDER BY observed_at DESC LIMIT 8;"
echo
echo "Newest claimed Codex process observations since start:"
sql_json "SELECT observation_id, pid, process_kind, matched_claim_id, ownership_status, port_bindings, datetime(observed_at_ms/1000,'unixepoch') AS observed_at_utc FROM process_observation WHERE process_kind='codex_app_server' AND observed_at_ms >= ${STARTED_AT_MS} ORDER BY observed_at_ms DESC LIMIT 5;"
echo
echo "Work item row:"
sql_json "SELECT work_item_id, mission_id, lane, target_provider_or_agent, status, owner_claim_ids, proof_receipts, executing, last_heartbeat_ms FROM work_item WHERE work_item_id='${WORK_ITEM_ID}' LIMIT 1;"
echo
echo "Mission row:"
sql_json "SELECT mission_id, friday_conversation_id, status, datetime(created_at_ms/1000,'unixepoch') AS created_at_utc, datetime(updated_at_ms/1000,'unixepoch') AS updated_at_utc FROM mission WHERE mission_id='${MISSION_ID}' LIMIT 1;"
echo
echo "Surface thread row:"
sql_json "SELECT surface_thread_id, friday_conversation_id, mission_id, surface_kind, delivery_route, visibility_policy, datetime(created_at_ms/1000,'unixepoch') AS created_at_utc, datetime(updated_at_ms/1000,'unixepoch') AS updated_at_utc FROM surface_thread WHERE surface_thread_id='${SURFACE_THREAD_ID}' LIMIT 1;"
echo "----------------------------------------------"

if [ -n "${pass_reason}" ]; then
  if [ "${WORK_ITEM_LINKED_PROOF:-0}" -gt 0 ] \
    && [ "${WORK_ITEM_CLAIM_BOUND_PROCESS_PROOF:-0}" -gt 0 ] \
    && [ "${WORK_ITEM_SURFACE_BOUND_PROOF:-0}" -gt 0 ] \
    && [ "${UNPROVED_LINKED_SESSION_RUNS:-0}" -eq 0 ]; then
    echo "PASS (STRONG) - ${pass_reason}; matching WorkItem proof, bound Mission SurfaceThread, claim-bound Codex process observation, and per-run proof reconciliation also present."
    if [ "${RUN_KIND}" = "organic" ]; then
      echo "Truth: operator-triggered organic Codex spawn through Friday; one organic row is not Phase-1 done / not D8 / not GO."
    else
      echo "Truth: operator-triggered Codex mission proof, not D8 / not 20-session soak / not GO."
    fi
    exit 0
  fi
  if [ "${WORK_ITEM_COMPLETED:-0}" -eq 0 ]; then
    echo "PASS (PARTIAL) - ${pass_reason}; this WorkItem did not reach completed_with_proof in the polling window."
    echo "Truth: Codex mission model+observe event proof is present, but WorkItem completion evidence remains incomplete."
    exit 2
  fi
  if [ "${WORK_ITEM_LINKED_PROOF:-0}" -eq 0 ]; then
    echo "PASS (PARTIAL) - ${pass_reason}; completed WorkItem did not have a matching ledger-linked friday://agent-run proof receipt in the polling window."
    echo "Truth: Codex mission model+observe event proof is present, but WorkItem outcome proof is not correlated to the observed ledger/event evidence."
    exit 2
  fi
  if [ "${WORK_ITEM_CLAIM_BOUND_PROCESS_PROOF:-0}" -eq 0 ]; then
    echo "PASS (PARTIAL) - ${pass_reason}; claim-bound Codex process observation was not proven for this WorkItem."
    echo "Truth: Codex mission model+observe event proof is present, but full P0 ownership/process evidence remains incomplete."
    exit 2
  fi
  if [ "${WORK_ITEM_SURFACE_BOUND_PROOF:-0}" -eq 0 ]; then
    echo "PASS (PARTIAL) - ${pass_reason}; bound Mission SurfaceThread was not proven for this WorkItem."
    echo "Truth: Codex mission model+observe event proof is present, but operator surface binding remains incomplete."
    exit 2
  fi
  echo "PASS (PARTIAL) - ${pass_reason}; at least one ledger-linked Codex session run lacked matching completed WorkItem proof."
  echo "Truth: Codex mission model+observe event proof is present, but per-run outcome proof reconciliation remains incomplete."
  exit 2
fi

echo "FAIL - no Codex ledger+provider-session linked event appeared within ${TIMEOUT_SEC}s."
echo "Truth: intake HTTP 200 alone is not enough; inspect TS/Rust logs for auto-dispatch or Codex route failure."
exit 1
