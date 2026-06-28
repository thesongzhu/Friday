#!/usr/bin/env bash
#
# Read-only Claude provider-session artifact audit for C1/C2 parity capture.
#
# This is intentionally narrower than friday-observe-wrapper-d8-audit.sh. Claude
# mission proofs are mirrored through provider_session_link/event rows; they do
# not produce Codex-style local app-server process observations. Passing here is
# artifact evidence only, not D8, not a soak, not organic, and not GO.
set -euo pipefail

readonly RUST_HUB_DB="${FRIDAY_HUB_AGENT_RUN_DB_PATH:-${HOME}/Library/Application Support/Friday/state/rust-hub.sqlite}"
readonly SINCE_MS="${FRIDAY_CLAUDE_PROVIDER_SESSION_AUDIT_SINCE_MS:-0}"
readonly ALLOW_UNSCOPED="${FRIDAY_CLAUDE_PROVIDER_SESSION_AUDIT_ALLOW_UNSCOPED:-0}"
readonly REQUIRED_RUNS="${FRIDAY_CLAUDE_PROVIDER_SESSION_AUDIT_REQUIRED_RUNS:-1}"
readonly CLAUDE_MODEL="${FRIDAY_CLAUDE_PROVIDER_SESSION_AUDIT_MODEL:-claude-opus-4-8}"

SQLITE_BIN="$(command -v sqlite3 || true)"
if [ -z "${SQLITE_BIN}" ] && [ -x "${ANDROID_HOME:-${HOME}/Library/Android/sdk}/platform-tools/sqlite3" ]; then
  SQLITE_BIN="${ANDROID_HOME:-${HOME}/Library/Android/sdk}/platform-tools/sqlite3"
fi

require_nonnegative_int() {
  local name="$1"
  local value="$2"
  if [[ ! "${value}" =~ ^[0-9]+$ ]]; then
    echo "FATAL: ${name} must be a non-negative integer; got '${value}'." >&2
    exit 3
  fi
}

require_positive_int() {
  local name="$1"
  local value="$2"
  if [[ ! "${value}" =~ ^[1-9][0-9]*$ ]]; then
    echo "FATAL: ${name} must be a positive integer; got '${value}'." >&2
    exit 3
  fi
}

require_nonnegative_int "FRIDAY_CLAUDE_PROVIDER_SESSION_AUDIT_SINCE_MS" "${SINCE_MS}"
require_positive_int "FRIDAY_CLAUDE_PROVIDER_SESSION_AUDIT_REQUIRED_RUNS" "${REQUIRED_RUNS}"
if [ "${ALLOW_UNSCOPED}" != "0" ] && [ "${ALLOW_UNSCOPED}" != "1" ]; then
  echo "FATAL: FRIDAY_CLAUDE_PROVIDER_SESSION_AUDIT_ALLOW_UNSCOPED must be 0 or 1; got '${ALLOW_UNSCOPED}'." >&2
  exit 3
fi
if [ "${SINCE_MS}" = "0" ] && [ "${ALLOW_UNSCOPED}" != "1" ]; then
  echo "FATAL: set FRIDAY_CLAUDE_PROVIDER_SESSION_AUDIT_SINCE_MS or ALLOW_UNSCOPED=1." >&2
  exit 3
fi
if [ -z "${SQLITE_BIN}" ]; then
  echo "FATAL: no sqlite3 binary found on PATH." >&2
  exit 3
fi
if [ ! -r "${RUST_HUB_DB}" ]; then
  echo "FATAL: Rust hub DB is not readable at: ${RUST_HUB_DB}" >&2
  exit 3
fi

sql_scalar() {
  local sql="$1"
  local value
  if ! value="$("${SQLITE_BIN}" -readonly "file:${RUST_HUB_DB}?mode=ro" "${sql}" 2>/dev/null)"; then
    echo "FATAL: SQLite query failed." >&2
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

require_schema_column "provider_session_link" "friday_session_id"
require_schema_column "provider_session_link" "provider"
require_schema_column "provider_session_link" "sync_mode"
require_schema_column "provider_session_link" "last_provider_seen_at"
require_schema_column "provider_session_event" "friday_session_id"
require_schema_column "provider_session_event" "provider"
require_schema_column "provider_session_event" "token_ledger_ref"
require_schema_column "provider_session_event" "observed_at"
require_schema_column "token_ledger" "ledger_id"
require_schema_column "token_ledger" "run_id"
require_schema_column "token_ledger" "provider_kind"
require_schema_column "token_ledger" "model"
require_schema_column "token_ledger" "fallback"
require_schema_column "token_ledger" "total_tokens"
require_schema_column "token_ledger" "created_at"
require_schema_column "work_item" "work_item_id"
require_schema_column "work_item" "mission_id"
require_schema_column "work_item" "lane"
require_schema_column "work_item" "target_provider_or_agent"
require_schema_column "work_item" "status"
require_schema_column "work_item" "proof_receipts"
require_schema_column "work_item" "updated_at_ms"
require_schema_column "mission" "mission_id"
require_schema_column "mission" "friday_conversation_id"
require_schema_column "mission" "created_at_ms"
require_schema_column "surface_thread" "surface_thread_id"
require_schema_column "surface_thread" "mission_id"
require_schema_column "surface_thread" "friday_conversation_id"
require_schema_column "surface_thread" "created_at_ms"

linked_mirror_runs="$(sql_count "Claude linked mirror runs" "
  SELECT COUNT(DISTINCT ledger.run_id)
  FROM provider_session_event event
  JOIN provider_session_link link
    ON link.friday_session_id = event.friday_session_id
   AND link.provider = event.provider
  JOIN token_ledger ledger
    ON ledger.ledger_id = event.token_ledger_ref
  WHERE event.provider = 'claude'
    AND link.provider = 'claude'
    AND link.sync_mode = 'friday_local_mirror'
    AND event.observed_at >= ${SINCE_MS}
    AND COALESCE(event.token_ledger_ref,'') <> ''
    AND ledger.provider_kind = 'anthropic'
    AND ledger.model = '${CLAUDE_MODEL}'
    AND ledger.fallback = 0
    AND ledger.total_tokens > 0
    AND ledger.created_at >= ${SINCE_MS};
")"

outcome_proof_runs="$(sql_count "Claude outcome proof runs" "
  WITH raw_proof AS (
    SELECT
      proof.value AS proof_receipt,
      replace(proof.value, 'proof://outcome/AnswerProduced/', '') AS payload
    FROM work_item w
    JOIN json_each(w.proof_receipts) proof
      ON proof.value IS NOT NULL
    WHERE w.lane = 'claude'
      AND COALESCE(w.target_provider_or_agent,'') = 'claude'
      AND w.status = 'completed_with_proof'
      AND w.updated_at_ms >= ${SINCE_MS}
      AND proof.value LIKE 'proof://outcome/AnswerProduced/%?signal=answer_len=%'
  ),
  parsed AS (
    SELECT
      CASE WHEN instr(payload, '?') > 0 THEN substr(payload, 1, instr(payload, '?') - 1) ELSE payload END AS run_id,
      CASE WHEN instr(payload, 'answer_len=') > 0 THEN substr(payload, instr(payload, 'answer_len=') + length('answer_len=')) ELSE '' END AS answer_len
    FROM raw_proof
  )
  SELECT COUNT(DISTINCT p.run_id)
  FROM parsed p
  JOIN token_ledger ledger
    ON ledger.run_id = p.run_id
   AND ledger.provider_kind = 'anthropic'
   AND ledger.model = '${CLAUDE_MODEL}'
   AND ledger.fallback = 0
   AND ledger.total_tokens > 0
   AND ledger.created_at >= ${SINCE_MS}
  JOIN provider_session_event event
    ON event.token_ledger_ref = ledger.ledger_id
   AND event.provider = 'claude'
   AND event.observed_at >= ${SINCE_MS}
  JOIN provider_session_link link
    ON link.friday_session_id = event.friday_session_id
   AND link.provider = event.provider
   AND link.sync_mode = 'friday_local_mirror'
  WHERE CAST(p.answer_len AS INTEGER) > 0;
")"

surface_bound_runs="$(sql_count "Claude surface-bound outcome proof runs" "
  WITH raw_proof AS (
    SELECT
      w.work_item_id,
      w.mission_id,
      proof.value AS proof_receipt,
      replace(proof.value, 'proof://outcome/AnswerProduced/', '') AS payload
    FROM work_item w
    JOIN json_each(w.proof_receipts) proof
      ON proof.value IS NOT NULL
    WHERE w.lane = 'claude'
      AND COALESCE(w.target_provider_or_agent,'') = 'claude'
      AND w.status = 'completed_with_proof'
      AND w.updated_at_ms >= ${SINCE_MS}
      AND proof.value LIKE 'proof://outcome/AnswerProduced/%?signal=answer_len=%'
  ),
  parsed AS (
    SELECT
      work_item_id,
      mission_id,
      CASE WHEN instr(payload, '?') > 0 THEN substr(payload, 1, instr(payload, '?') - 1) ELSE payload END AS run_id
    FROM raw_proof
  )
  SELECT COUNT(DISTINCT p.run_id)
  FROM parsed p
  JOIN token_ledger ledger
    ON ledger.run_id = p.run_id
   AND ledger.provider_kind = 'anthropic'
   AND ledger.model = '${CLAUDE_MODEL}'
   AND ledger.fallback = 0
   AND ledger.total_tokens > 0
   AND ledger.created_at >= ${SINCE_MS}
  JOIN mission m
    ON m.mission_id = p.mission_id
   AND m.created_at_ms >= ${SINCE_MS}
  JOIN surface_thread surface
    ON surface.mission_id = p.mission_id
   AND surface.friday_conversation_id = m.friday_conversation_id
   AND surface.created_at_ms >= ${SINCE_MS};
")"

orphan_mirror_events="$(sql_count "orphan Claude mirror events" "
  SELECT COUNT(*)
  FROM provider_session_event event
  LEFT JOIN token_ledger ledger
    ON ledger.ledger_id = event.token_ledger_ref
  WHERE event.provider = 'claude'
    AND event.observed_at >= ${SINCE_MS}
    AND (COALESCE(event.token_ledger_ref,'') = '' OR ledger.ledger_id IS NULL);
")"

echo "Friday Claude provider-session artifact audit"
echo "----------------------------------------------"
echo "DB: ${RUST_HUB_DB}"
echo "since_ms: ${SINCE_MS}"
echo "required_runs: ${REQUIRED_RUNS}"
echo "model: ${CLAUDE_MODEL}"
echo
echo "Evidence:"
echo "  linked_mirror_runs=${linked_mirror_runs}"
echo "  outcome_proof_runs=${outcome_proof_runs}"
echo "  surface_bound_runs=${surface_bound_runs}"
echo "  orphan_mirror_events=${orphan_mirror_events}"
echo

failures=0
if [ "${linked_mirror_runs}" -lt "${REQUIRED_RUNS}" ]; then
  echo "FAIL: fewer than ${REQUIRED_RUNS} Claude mirror run(s) with linked token ledger." >&2
  failures=$((failures + 1))
fi
if [ "${outcome_proof_runs}" -lt "${REQUIRED_RUNS}" ]; then
  echo "FAIL: fewer than ${REQUIRED_RUNS} Claude outcome proof run(s) joined to mirror evidence." >&2
  failures=$((failures + 1))
fi
if [ "${surface_bound_runs}" -lt "${REQUIRED_RUNS}" ]; then
  echo "FAIL: fewer than ${REQUIRED_RUNS} surface-bound Claude outcome proof run(s)." >&2
  failures=$((failures + 1))
fi
if [ "${orphan_mirror_events}" -ne 0 ]; then
  echo "FAIL: Claude mirror event(s) without valid token_ledger_ref found." >&2
  failures=$((failures + 1))
fi

if [ "${failures}" -ne 0 ]; then
  echo "Truth: Claude artifact evidence is incomplete; no live parity / D8 / GO claimed."
  exit 1
fi

echo "PASS - Claude provider-session mirror, token ledger, outcome proof, and surface binding are joined."
echo "Truth: C1/C2 artifact evidence only; strict organic=0; not D8, not soak, not UI-device-channel proof, not GO."
