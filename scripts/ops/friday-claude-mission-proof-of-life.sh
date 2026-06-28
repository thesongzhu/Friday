#!/usr/bin/env bash
#
# friday-claude-mission-proof-of-life.sh
# --------------------------------------
# Operator-run proof for the live Claude mission-intake path.
#
# What this does:
#   1. Prompts locally for the Friday local passphrase (hidden; never echoed),
#      or reads it from stdin when the keychain wrapper is used.
#   2. Logs in to the loopback TS hub and captures a bearer in memory only.
#   3. POSTs one Claude-targeted Mission Spine intake:
#        lane="claude", targetProviderOrAgent="claude".
#   4. Polls the live Rust hub DB read-only for a completed WorkItem proof
#      receipt joined to a same-run non-fallback Anthropic token_ledger row.
#
# Preflight:
#   Set FRIDAY_CLAUDE_MISSION_PROOF_PREFLIGHT_ONLY=1 to check local readiness
#   without reading a passphrase, logging in, creating traffic, or spending quota.
#
# Truth boundary:
#   PASS here is one operator-triggered Claude mission proof. It is NOT D8, NOT a
#   soak, NOT UI/device/channel proof, and NOT GO. Claude evidence is intentionally
#   WorkItem proof + Anthropic ledger attribution; it does not require Codex
#   observe-wrapper provider-session/process rows.
#
# Secret hygiene:
#   - The passphrase is read with `read -rs` by default, or from stdin only when
#     FRIDAY_CLAUDE_MISSION_PROOF_PASSPHRASE_STDIN=1 is set by a local wrapper.
#   - It is streamed to curl via stdin, then unset.
#   - The bearer is stored only in a shell variable and never printed.
#   - The DB is opened read-only.
#
set -euo pipefail

readonly TS_HUB="${FRIDAY_TS_HUB_URL:-http://127.0.0.1:3141}"
readonly RUST_HUB_DB="${FRIDAY_HUB_AGENT_RUN_DB_PATH:-${HOME}/Library/Application Support/Friday/state/rust-hub.sqlite}"
readonly OWNER_PRINCIPAL="${FRIDAY_CLAUDE_MISSION_PROOF_OWNER:-admin-001}"
readonly TIMEOUT_SEC="${FRIDAY_CLAUDE_MISSION_PROOF_TIMEOUT_SEC:-240}"
readonly POLL_INTERVAL_SEC="${FRIDAY_CLAUDE_MISSION_PROOF_POLL_INTERVAL_SEC:-3}"
readonly PASSPHRASE_STDIN="${FRIDAY_CLAUDE_MISSION_PROOF_PASSPHRASE_STDIN:-0}"
readonly PREFLIGHT_ONLY="${FRIDAY_CLAUDE_MISSION_PROOF_PREFLIGHT_ONLY:-0}"
readonly OUTCOME_CHECKED="${FRIDAY_CLAUDE_MISSION_PROOF_OUTCOME_CHECKED:-0}"
readonly RUST_WS_LAUNCH_WRAPPER="${FRIDAY_RUST_AGENT_RUN_WS_WRAPPER:-${HOME}/.friday/launchd/rust-agent-run-ws-server-run.sh}"
readonly RUST_WS_LAUNCH_PLIST="${FRIDAY_RUST_AGENT_RUN_WS_LAUNCH_PLIST:-${HOME}/Library/LaunchAgents/com.friday.rust-agent-run-ws-server.plist}"
readonly RUST_WS_LAUNCH_LABEL="${FRIDAY_RUST_AGENT_RUN_WS_LAUNCH_LABEL:-com.friday.rust-agent-run-ws-server}"
readonly RUST_WS_LAUNCH_DOMAIN="${FRIDAY_RUST_AGENT_RUN_WS_LAUNCH_DOMAIN:-gui/$(id -u)}"
readonly RUST_WS_HOST="127.0.0.1"
readonly RUST_WS_PORT="48750"
readonly TS_HUB_LAUNCH_PLIST="${FRIDAY_TS_HUB_LAUNCH_PLIST:-${HOME}/Library/LaunchAgents/com.friday.hub.plist}"
readonly TS_HUB_LAUNCH_LABEL="${FRIDAY_TS_HUB_LAUNCH_LABEL:-com.friday.hub}"
readonly TS_HUB_LAUNCH_DOMAIN="${FRIDAY_TS_HUB_LAUNCH_DOMAIN:-gui/$(id -u)}"
readonly CLAUDE_MODEL="claude-opus-4-8"
readonly RUN_KIND="${FRIDAY_CLAUDE_MISSION_PROOF_RUN_KIND:-proof}"
readonly SURFACE_KIND="${FRIDAY_CLAUDE_MISSION_PROOF_SURFACE_KIND:-mobile}"
readonly DELIVERY_ROUTE="${FRIDAY_CLAUDE_MISSION_PROOF_DELIVERY_ROUTE:-ops://claude-mission-proof-of-life}"
readonly MISSION_TITLE="${FRIDAY_CLAUDE_MISSION_PROOF_TITLE:-Claude proof token}"
readonly MISSION_INTENT="${FRIDAY_CLAUDE_MISSION_PROOF_INTENT:-Answer exactly FRIDAY_CLAUDE_PROOF_OK.}"
readonly CAPABILITY_ID="${FRIDAY_CLAUDE_MISSION_PROOF_CAPABILITY_ID:-ask_friday.claude}"
readonly BODY_REF_PREFIX="friday://body/ops/claude-mission-proof-of-life"

SQLITE_BIN="$(command -v sqlite3 || true)"
if [ -z "${SQLITE_BIN}" ] && [ -x "${ANDROID_HOME:-${HOME}/Library/Android/sdk}/platform-tools/sqlite3" ]; then
  SQLITE_BIN="${ANDROID_HOME:-${HOME}/Library/Android/sdk}/platform-tools/sqlite3"
fi

for bin in curl jq node launchctl; do
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

require_positive_int() {
  local name="$1"
  local value="$2"
  if [[ ! "${value}" =~ ^[1-9][0-9]*$ ]]; then
    echo "FATAL: ${name} must be a positive integer; got '${value}'." >&2
    exit 3
  fi
}

require_positive_int "FRIDAY_CLAUDE_MISSION_PROOF_TIMEOUT_SEC" "${TIMEOUT_SEC}"
require_positive_int "FRIDAY_CLAUDE_MISSION_PROOF_POLL_INTERVAL_SEC" "${POLL_INTERVAL_SEC}"
if [ "${PASSPHRASE_STDIN}" != "0" ] && [ "${PASSPHRASE_STDIN}" != "1" ]; then
  echo "FATAL: FRIDAY_CLAUDE_MISSION_PROOF_PASSPHRASE_STDIN must be 0 or 1; got '${PASSPHRASE_STDIN}'." >&2
  exit 3
fi
if [ "${PREFLIGHT_ONLY}" != "0" ] && [ "${PREFLIGHT_ONLY}" != "1" ]; then
  echo "FATAL: FRIDAY_CLAUDE_MISSION_PROOF_PREFLIGHT_ONLY must be 0 or 1; got '${PREFLIGHT_ONLY}'." >&2
  exit 3
fi
if [ "${OUTCOME_CHECKED}" != "0" ] && [ "${OUTCOME_CHECKED}" != "1" ]; then
  echo "FATAL: FRIDAY_CLAUDE_MISSION_PROOF_OUTCOME_CHECKED must be 0 or 1; got '${OUTCOME_CHECKED}'." >&2
  exit 3
fi
case "${RUN_KIND}" in
  proof|organic) ;;
  *)
    echo "FATAL: FRIDAY_CLAUDE_MISSION_PROOF_RUN_KIND must be proof or organic; got '${RUN_KIND}'." >&2
    exit 3
    ;;
esac
case "${SURFACE_KIND}" in
  mobile|desktop) ;;
  *)
    echo "FATAL: FRIDAY_CLAUDE_MISSION_PROOF_SURFACE_KIND must be mobile or desktop; got '${SURFACE_KIND}'." >&2
    exit 3
    ;;
esac
if [ "${POLL_INTERVAL_SEC}" -gt "${TIMEOUT_SEC}" ]; then
  echo "FATAL: poll interval cannot be greater than timeout." >&2
  exit 3
fi

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

require_file_contains() {
  local file="$1"
  local needle="$2"
  local label="$3"
  if ! grep -Fq -- "${needle}" "${file}"; then
    echo "FATAL: ${label} missing from ${file}." >&2
    exit 3
  fi
}

require_file_contains "${RUST_WS_LAUNCH_WRAPPER}" "export FRIDAY_MISSION_BOUND_RUN=1" "mission-bound run flag"
require_file_contains "${RUST_WS_LAUNCH_WRAPPER}" "export FRIDAY_CLAUDE_ROUTE_ENABLED=1" "Claude route flag"
require_file_contains "${RUST_WS_LAUNCH_WRAPPER}" "--validate-claude" "Rust server Claude validation flag"

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

check_optional_plist_env_equals "${TS_HUB_LAUNCH_PLIST}" "FRIDAY_MISSION_AUTO_DISPATCH" "1" "TS hub mission auto-dispatch flag"
check_optional_plist_env_equals "${TS_HUB_LAUNCH_PLIST}" "FRIDAY_MISSION_SPINE_ROUTES_VIA_RUST" "1" "TS hub mission spine Rust route flag"
check_optional_plist_env_equals "${TS_HUB_LAUNCH_PLIST}" "FRIDAY_ROUTE_AGENT_RUN_VIA_RUST" "1" "TS hub agent-run Rust route flag"
check_optional_plist_env_equals "${TS_HUB_LAUNCH_PLIST}" "FRIDAY_HUB_AGENT_RUN_WS_PORT" "48750" "TS hub Rust agent-run WS port"
check_optional_plist_env_equals "${TS_HUB_LAUNCH_PLIST}" "FRIDAY_HUB_AGENT_RUN_DB_PATH" "${RUST_HUB_DB}" "TS hub Rust DB path"

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

require_launchctl_env_equals "${TS_HUB_LAUNCHCTL_PRINT}" "FRIDAY_MISSION_AUTO_DISPATCH" "1" "live TS hub mission auto-dispatch flag"
require_launchctl_env_equals "${TS_HUB_LAUNCHCTL_PRINT}" "FRIDAY_MISSION_SPINE_ROUTES_VIA_RUST" "1" "live TS hub mission spine Rust route flag"
require_launchctl_env_equals "${TS_HUB_LAUNCHCTL_PRINT}" "FRIDAY_ROUTE_AGENT_RUN_VIA_RUST" "1" "live TS hub agent-run Rust route flag"
require_launchctl_env_equals "${TS_HUB_LAUNCHCTL_PRINT}" "FRIDAY_HUB_AGENT_RUN_WS_PORT" "48750" "live TS hub Rust agent-run WS port"
require_launchctl_env_equals "${TS_HUB_LAUNCHCTL_PRINT}" "FRIDAY_HUB_AGENT_RUN_DB_PATH" "${RUST_HUB_DB}" "live TS hub Rust DB path"

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

sql_json() {
  local sql="$1"
  "${SQLITE_BIN}" -readonly -json "file:${RUST_HUB_DB}?mode=ro" "${sql}" 2>/dev/null || printf '[]'
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

require_schema_column "token_ledger" "ledger_id"
require_schema_column "token_ledger" "provider_kind"
require_schema_column "token_ledger" "model"
require_schema_column "token_ledger" "base_url_host"
require_schema_column "token_ledger" "total_tokens"
require_schema_column "token_ledger" "fallback"
require_schema_column "token_ledger" "created_at"
require_schema_column "token_ledger" "run_id"
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

if [ "${PREFLIGHT_ONLY}" = "1" ]; then
  echo "Claude Mission proof preflight OK."
  echo "  TS hub: ${TS_HUB}"
  echo "  Rust DB: ${RUST_HUB_DB}"
  echo "  schemaReady: ok"
  echo "  rustWsPort: ok (${RUST_WS_HOST}:${RUST_WS_PORT})"
  echo "  rustWsLaunchWrapper: ok (${RUST_WS_LAUNCH_WRAPPER})"
  echo "  rustWsLaunchRuntime: ok (${RUST_WS_LAUNCH_DOMAIN}/${RUST_WS_LAUNCH_LABEL})"
  echo "  tsHubLaunchFlags: ok"
  echo "  tsHubLaunchRuntime: ok (${TS_HUB_LAUNCH_DOMAIN}/${TS_HUB_LAUNCH_LABEL})"
  if curl -sS --max-time 5 "${TS_HUB%/}/v1/health" >/dev/null 2>&1; then
    echo "  tsHealth: ok"
  else
    echo "  tsHealth: not-ok"
    exit 3
  fi
  echo "  anthropicLedgerRows: $(sql_count "preflight anthropic ledger" "SELECT COUNT(*) FROM token_ledger WHERE provider_kind='anthropic';")"
  echo "  claudeWorkItems: $(sql_count "preflight claude work items" "SELECT COUNT(*) FROM work_item WHERE lane='claude' OR target_provider_or_agent='claude';")"
  echo "  outcomeCheckedMode: ${OUTCOME_CHECKED}"
  echo "  runKind: ${RUN_KIND}"
  echo "  surfaceKind: ${SURFACE_KIND}"
  echo "  deliveryRoute: ${DELIVERY_ROUTE}"
  echo "Truth: preflight creates no traffic and proves only local readiness, not Claude proof / D8 / GO."
  exit 0
fi

readonly RUN_TAG="$(new_id)"
if [ "${RUN_KIND}" = "organic" ]; then
  readonly ID_PREFIX="claude-organic"
else
  readonly ID_PREFIX="claude-proof"
fi
readonly FRIDAY_CONVERSATION_ID="fconv_${ID_PREFIX//-/_}_${RUN_TAG//-/_}"
readonly MISSION_ID="${ID_PREFIX}-mission-${RUN_TAG}"
readonly WORK_ITEM_ID="${ID_PREFIX}-work-${RUN_TAG}"
readonly SURFACE_THREAD_ID="${ID_PREFIX}-surface-${RUN_TAG}"
readonly BODY_REF="${FRIDAY_CLAUDE_MISSION_PROOF_BODY_REF:-${BODY_REF_PREFIX}/${WORK_ITEM_ID}}"
readonly STARTED_AT_MS="$(now_ms)"

echo "Claude Mission proof starting."
echo "  TS hub: ${TS_HUB}"
echo "  Rust DB: ${RUST_HUB_DB}"
echo "  runKind: ${RUN_KIND}"
echo "  surfaceKind: ${SURFACE_KIND}"
echo "  deliveryRoute: ${DELIVERY_ROUTE}"
echo "  missionId: ${MISSION_ID}"
echo "  workItemId: ${WORK_ITEM_ID}"
echo "  startedAtMs: ${STARTED_AT_MS}"
echo "  outcomeCheckedMode: ${OUTCOME_CHECKED}"
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
trap 'unset TOKEN' EXIT
echo "Step 1 OK: authenticated (token captured, not shown)."

INTAKE_BODY="$(jq -nc \
  --arg conv "${FRIDAY_CONVERSATION_ID}" \
  --arg owner "${OWNER_PRINCIPAL}" \
  --arg surface "${SURFACE_THREAD_ID}" \
  --arg mission "${MISSION_ID}" \
  --arg work "${WORK_ITEM_ID}" \
  --arg surface_kind "${SURFACE_KIND}" \
  --arg delivery_route "${DELIVERY_ROUTE}" \
  --arg title "${MISSION_TITLE}" \
  --arg intent "${MISSION_INTENT}" \
  --arg capability_id "${CAPABILITY_ID}" \
  --arg body_ref "${BODY_REF}" \
  --arg outcome_checked "${OUTCOME_CHECKED}" \
  '{
    fridayConversationId: $conv,
    ownerPrincipal: $owner,
    surfaceThreadId: $surface,
    surfaceKind: $surface_kind,
    deliveryRoute: $delivery_route,
    visibilityPolicy: "compact",
    missionId: $mission,
    workItemId: $work,
    title: $title,
    intent: $intent,
    lane: "claude",
    targetProviderOrAgent: "claude",
    capabilityId: $capability_id,
    bodyRef: $body_ref,
    includesSensitiveContext: false
  } + (if $outcome_checked == "1" then {proofRequirements: ["outcome:AnswerProduced:>=1"]} else {} end)')"

echo "Step 2: POST /v1/mission-spine/intake (Claude target)..."
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
joined_proof=0
surface_bound_proof=0
work_status=""
while [ "$(date +%s)" -le "${deadline}" ]; do
  work_status="$(sql_scalar "SELECT COALESCE(status, '') FROM work_item WHERE work_item_id='${WORK_ITEM_ID}' LIMIT 1;")"
  if [ "${OUTCOME_CHECKED}" = "1" ]; then
    joined_proof="$(sql_count "this completed Claude work item with linked Anthropic outcome proof" "
      WITH raw_proof AS (
        SELECT
          w.work_item_id AS work_item_id,
          w.status AS status,
          proof.value AS proof_receipt,
          replace(proof.value, 'proof://outcome/AnswerProduced/', '') AS payload
        FROM work_item w
        JOIN json_each(w.proof_receipts) proof
          ON proof.value IS NOT NULL
        WHERE w.work_item_id='${WORK_ITEM_ID}'
          AND w.mission_id='${MISSION_ID}'
          AND w.lane='claude'
          AND COALESCE(w.target_provider_or_agent,'')='claude'
          AND w.status='completed_with_proof'
          AND w.updated_at_ms >= ${STARTED_AT_MS}
          AND proof.value LIKE 'proof://outcome/AnswerProduced/%?signal=answer_len=%'
      ),
      proof AS (
        SELECT
          work_item_id,
          status,
          proof_receipt,
          CASE WHEN instr(payload, '?') > 0 THEN substr(payload, 1, instr(payload, '?') - 1) ELSE payload END AS run_id,
          CASE WHEN instr(payload, 'answer_len=') > 0 THEN substr(payload, instr(payload, 'answer_len=') + length('answer_len=')) ELSE '' END AS answer_len
        FROM raw_proof
      )
      SELECT COUNT(*)
      FROM proof p
      JOIN token_ledger ledger
        ON ledger.run_id = p.run_id
       AND ledger.provider_kind='anthropic'
       AND ledger.model='${CLAUDE_MODEL}'
       AND ledger.fallback=0
       AND ledger.total_tokens > 0
       AND ledger.created_at >= ${STARTED_AT_MS}
      WHERE CAST(p.answer_len AS INTEGER) > 0;
    ")"
  else
    joined_proof="$(sql_count "this completed Claude work item with linked Anthropic ledger proof" "
      WITH proof AS (
        SELECT
          w.work_item_id AS work_item_id,
          w.status AS status,
          proof.value AS proof_receipt,
          replace(proof.value, 'friday://agent-run/', '') AS run_id
        FROM work_item w
        JOIN json_each(w.proof_receipts) proof
          ON proof.value IS NOT NULL
        WHERE w.work_item_id='${WORK_ITEM_ID}'
          AND w.mission_id='${MISSION_ID}'
          AND w.lane='claude'
          AND COALESCE(w.target_provider_or_agent,'')='claude'
          AND w.status='completed_with_proof'
          AND w.updated_at_ms >= ${STARTED_AT_MS}
      )
      SELECT COUNT(*)
      FROM proof p
      JOIN token_ledger ledger
        ON p.proof_receipt = 'friday://agent-run/' || ledger.run_id
       AND ledger.run_id = p.run_id
       AND ledger.provider_kind='anthropic'
       AND ledger.model='${CLAUDE_MODEL}'
       AND ledger.fallback=0
       AND ledger.total_tokens > 0
       AND ledger.created_at >= ${STARTED_AT_MS};
    ")"
  fi
  surface_bound_proof="$(sql_count "this completed Claude work item with bound surface thread" "
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
      AND w.lane = 'claude'
      AND COALESCE(w.target_provider_or_agent,'') = 'claude'
      AND w.status = 'completed_with_proof';
  ")"
  ledger_count="$(sql_count "anthropic ledger since start" "SELECT COUNT(*) FROM token_ledger WHERE provider_kind='anthropic' AND model='${CLAUDE_MODEL}' AND fallback=0 AND total_tokens>0 AND created_at >= ${STARTED_AT_MS};")"
  proof_count="$(sql_count "this completed claude proof receipts" "SELECT COUNT(*) FROM work_item w JOIN json_each(w.proof_receipts) proof ON proof.value IS NOT NULL WHERE w.work_item_id='${WORK_ITEM_ID}' AND w.status='completed_with_proof';")"
  printf 'Polling: outcomeChecked=%s workStatus=%s proofReceipts=%s anthropicLedger=%s joinedProof=%s surfaceBoundProof=%s\n' \
    "${OUTCOME_CHECKED}" "${work_status:-<none>}" "${proof_count}" "${ledger_count}" "${joined_proof}" "${surface_bound_proof}"
  if [ "${joined_proof}" -gt 0 ] && [ "${surface_bound_proof}" -gt 0 ]; then
    break
  fi
  sleep "${POLL_INTERVAL_SEC}"
done

echo
echo "----------------------------------------------"
echo "Mission: ${MISSION_ID}"
echo "Work item: ${WORK_ITEM_ID}"
echo "Started at ms: ${STARTED_AT_MS}"
echo
echo "Claude proof joined rows:"
if [ "${OUTCOME_CHECKED}" = "1" ]; then
  sql_json "
    WITH raw_proof AS (
      SELECT
        w.work_item_id AS work_item_id,
        w.mission_id AS mission_id,
        w.status AS status,
        proof.value AS proof_receipt,
        replace(proof.value, 'proof://outcome/AnswerProduced/', '') AS payload
      FROM work_item w
      JOIN json_each(w.proof_receipts) proof
        ON proof.value IS NOT NULL
      WHERE w.work_item_id='${WORK_ITEM_ID}'
        AND w.mission_id='${MISSION_ID}'
        AND w.lane='claude'
        AND COALESCE(w.target_provider_or_agent,'')='claude'
        AND proof.value LIKE 'proof://outcome/AnswerProduced/%?signal=answer_len=%'
    ),
    proof AS (
      SELECT
        work_item_id,
        mission_id,
        status,
        proof_receipt,
        CASE WHEN instr(payload, '?') > 0 THEN substr(payload, 1, instr(payload, '?') - 1) ELSE payload END AS run_id,
        CASE WHEN instr(payload, 'answer_len=') > 0 THEN substr(payload, instr(payload, 'answer_len=') + length('answer_len=')) ELSE '' END AS answer_len
      FROM raw_proof
    )
    SELECT
      p.work_item_id,
      p.mission_id,
      p.status,
      p.proof_receipt,
      p.run_id,
      p.answer_len,
      ledger.provider_kind,
      ledger.model,
      ledger.base_url_host,
      ledger.total_tokens,
      ledger.fallback,
      datetime(ledger.created_at/1000,'unixepoch') AS created_at_utc
    FROM proof p
    JOIN token_ledger ledger
      ON ledger.run_id=p.run_id
    WHERE ledger.created_at >= ${STARTED_AT_MS}
      AND CAST(p.answer_len AS INTEGER) > 0
    ORDER BY ledger.created_at DESC
    LIMIT 5;
  "
else
  sql_json "
    WITH proof AS (
      SELECT
        w.work_item_id AS work_item_id,
        w.mission_id AS mission_id,
        w.status AS status,
        proof.value AS proof_receipt,
        replace(proof.value, 'friday://agent-run/', '') AS run_id
      FROM work_item w
      JOIN json_each(w.proof_receipts) proof
        ON proof.value IS NOT NULL
      WHERE w.work_item_id='${WORK_ITEM_ID}'
        AND w.mission_id='${MISSION_ID}'
        AND w.lane='claude'
        AND COALESCE(w.target_provider_or_agent,'')='claude'
    )
    SELECT
      p.work_item_id,
      p.mission_id,
      p.status,
      p.proof_receipt,
      ledger.run_id,
      ledger.provider_kind,
      ledger.model,
      ledger.base_url_host,
      ledger.total_tokens,
      ledger.fallback,
      datetime(ledger.created_at/1000,'unixepoch') AS created_at_utc
    FROM proof p
    JOIN token_ledger ledger
      ON ledger.run_id=p.run_id
    WHERE ledger.created_at >= ${STARTED_AT_MS}
    ORDER BY ledger.created_at DESC
    LIMIT 5;
  "
fi
echo
echo "Work item row:"
sql_json "SELECT work_item_id, mission_id, lane, target_provider_or_agent, status, proof_receipts, datetime(updated_at_ms/1000,'unixepoch') AS updated_at_utc FROM work_item WHERE work_item_id='${WORK_ITEM_ID}' LIMIT 1;"
echo
echo "Mission row:"
sql_json "SELECT mission_id, friday_conversation_id, status, datetime(created_at_ms/1000,'unixepoch') AS created_at_utc, datetime(updated_at_ms/1000,'unixepoch') AS updated_at_utc FROM mission WHERE mission_id='${MISSION_ID}' LIMIT 1;"
echo
echo "Surface thread row:"
sql_json "SELECT surface_thread_id, friday_conversation_id, mission_id, surface_kind, delivery_route, visibility_policy, datetime(created_at_ms/1000,'unixepoch') AS created_at_utc, datetime(updated_at_ms/1000,'unixepoch') AS updated_at_utc FROM surface_thread WHERE surface_thread_id='${SURFACE_THREAD_ID}' LIMIT 1;"
echo "----------------------------------------------"

if [ "${joined_proof:-0}" -gt 0 ] && [ "${surface_bound_proof:-0}" -gt 0 ]; then
  if [ "${OUTCOME_CHECKED}" = "1" ]; then
    echo "PASS (STRONG OUTCOME) - this Claude WorkItem completed_with_proof, its AnswerProduced outcome proof receipt joins to a same-run non-fallback Anthropic ledger row for ${CLAUDE_MODEL}, and the operator surface binding is present."
  else
    echo "PASS (STRONG) - this Claude WorkItem completed_with_proof, the proof receipt joins to a same-run non-fallback Anthropic ledger row for ${CLAUDE_MODEL}, and the operator surface binding is present."
  fi
  if [ "${RUN_KIND}" = "organic" ]; then
    echo "Truth: operator-triggered organic Claude spawn through Friday; one organic row is not Phase-1 done / not D8 / not GO."
  else
    echo "Truth: operator-triggered Claude mission proof, not D8 / not soak / not UI-device-channel proof / not GO."
  fi
  exit 0
fi

if [ "${joined_proof:-0}" -gt 0 ]; then
  if [ "${OUTCOME_CHECKED}" = "1" ]; then
    echo "PASS (PARTIAL OUTCOME) - Claude WorkItem AnswerProduced outcome proof receipt joined to Anthropic ledger, but bound Mission SurfaceThread was not proven in the polling window."
  else
    echo "PASS (PARTIAL) - Claude WorkItem proof receipt joined to Anthropic ledger, but bound Mission SurfaceThread was not proven in the polling window."
  fi
  echo "Truth: Claude route+ledger proof is present, but operator surface binding remains incomplete."
  exit 2
fi

echo "FAIL - no Claude WorkItem proof + Anthropic ledger join appeared within ${TIMEOUT_SEC}s. finalWorkStatus=${work_status:-<none>}"
echo "Truth: intake HTTP 200 alone is not enough; inspect TS/Rust logs for auto-dispatch or Claude route failure."
exit 1
