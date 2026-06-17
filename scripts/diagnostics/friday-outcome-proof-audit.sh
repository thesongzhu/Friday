#!/usr/bin/env bash
#
# friday-outcome-proof-audit.sh
# -----------------------------
# Read-only audit for typed outcome proof receipts.
#
# This script does not create provider traffic and does not read secrets. It
# verifies that already-produced AnswerProduced outcome receipts have a
# same-run non-fallback token_ledger row and a positive answer length signal.
#
# Truth boundary:
#   A PASS here only proves stored DB evidence for the scoped window. It does
#   not produce evidence, run D8, prove UI/device/channel behavior, or imply GO.
#
set -euo pipefail

readonly RUST_HUB_DB="${FRIDAY_HUB_AGENT_RUN_DB_PATH:-/Users/jarvis/Library/Application Support/Friday/state/rust-hub.sqlite}"
readonly SINCE_MS="${FRIDAY_OUTCOME_PROOF_AUDIT_SINCE_MS:-0}"
readonly ALLOW_UNSCOPED="${FRIDAY_OUTCOME_PROOF_AUDIT_ALLOW_UNSCOPED:-0}"
readonly REQUIRED_RECEIPTS="${FRIDAY_OUTCOME_PROOF_AUDIT_REQUIRED_RECEIPTS:-1}"

SQLITE_BIN="$(command -v sqlite3 || true)"
if [ -z "${SQLITE_BIN}" ] && [ -x "/Users/jarvis/Library/Android/sdk/platform-tools/sqlite3" ]; then
  SQLITE_BIN="/Users/jarvis/Library/Android/sdk/platform-tools/sqlite3"
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

require_nonnegative_int "FRIDAY_OUTCOME_PROOF_AUDIT_SINCE_MS" "${SINCE_MS}"
require_positive_int "FRIDAY_OUTCOME_PROOF_AUDIT_REQUIRED_RECEIPTS" "${REQUIRED_RECEIPTS}"
if [ "${ALLOW_UNSCOPED}" != "0" ] && [ "${ALLOW_UNSCOPED}" != "1" ]; then
  echo "FATAL: FRIDAY_OUTCOME_PROOF_AUDIT_ALLOW_UNSCOPED must be 0 or 1; got '${ALLOW_UNSCOPED}'." >&2
  exit 3
fi
if [ "${SINCE_MS}" = "0" ] && [ "${ALLOW_UNSCOPED}" != "1" ]; then
  echo "FATAL: set FRIDAY_OUTCOME_PROOF_AUDIT_SINCE_MS, or explicitly set FRIDAY_OUTCOME_PROOF_AUDIT_ALLOW_UNSCOPED=1." >&2
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

require_schema_column "work_item" "work_item_id"
require_schema_column "work_item" "mission_id"
require_schema_column "work_item" "status"
require_schema_column "work_item" "updated_at_ms"
require_schema_column "work_item" "proof_receipts"
require_schema_column "token_ledger" "ledger_id"
require_schema_column "token_ledger" "run_id"
require_schema_column "token_ledger" "provider_kind"
require_schema_column "token_ledger" "model"
require_schema_column "token_ledger" "base_url_host"
require_schema_column "token_ledger" "fallback"
require_schema_column "token_ledger" "total_tokens"
require_schema_column "token_ledger" "created_at"

malformed_json_work_items="$(
  sql_count "malformed JSON proof_receipts" "
    SELECT COUNT(*)
    FROM work_item
    WHERE COALESCE(updated_at_ms,0) >= ${SINCE_MS}
      AND COALESCE(proof_receipts,'[]') <> '[]'
      AND json_valid(proof_receipts) = 0;
  "
)"

outcome_answer_receipts="$(
  sql_count "AnswerProduced outcome receipts" "
    WITH valid_work AS (
      SELECT work_item_id, mission_id, status, updated_at_ms, proof_receipts
      FROM work_item
      WHERE COALESCE(updated_at_ms,0) >= ${SINCE_MS}
        AND json_valid(proof_receipts)
    )
    SELECT COUNT(*)
    FROM valid_work wi
    JOIN json_each(wi.proof_receipts) proof
    WHERE wi.status='completed_with_proof'
      AND proof.value LIKE 'proof://outcome/AnswerProduced/%?signal=answer_len=%';
  "
)"

malformed_answer_receipts="$(
  sql_count "malformed AnswerProduced outcome receipts" "
    WITH valid_work AS (
      SELECT work_item_id, mission_id, status, updated_at_ms, proof_receipts
      FROM work_item
      WHERE COALESCE(updated_at_ms,0) >= ${SINCE_MS}
        AND json_valid(proof_receipts)
    )
    SELECT COUNT(*)
    FROM valid_work wi
    JOIN json_each(wi.proof_receipts) proof
    WHERE proof.value LIKE 'proof://outcome/AnswerProduced/%'
      AND proof.value NOT LIKE 'proof://outcome/AnswerProduced/%?signal=answer_len=%';
  "
)"

joined_answer_receipts="$(
  sql_count "AnswerProduced receipts joined to ledger" "
    WITH valid_work AS (
      SELECT work_item_id, mission_id, status, updated_at_ms, proof_receipts
      FROM work_item
      WHERE COALESCE(updated_at_ms,0) >= ${SINCE_MS}
        AND json_valid(proof_receipts)
    ),
    parsed AS (
      SELECT
        wi.work_item_id,
        wi.updated_at_ms,
        proof.value AS proof_receipt,
        substr(replace(proof.value, 'proof://outcome/AnswerProduced/', ''), 1, instr(replace(proof.value, 'proof://outcome/AnswerProduced/', ''), '?signal=answer_len=') - 1) AS run_id,
        substr(replace(proof.value, 'proof://outcome/AnswerProduced/', ''), instr(replace(proof.value, 'proof://outcome/AnswerProduced/', ''), '?signal=answer_len=') + length('?signal=answer_len=')) AS answer_len
      FROM valid_work wi
      JOIN json_each(wi.proof_receipts) proof
      WHERE wi.status='completed_with_proof'
        AND proof.value LIKE 'proof://outcome/AnswerProduced/%?signal=answer_len=%'
    )
    SELECT COUNT(*)
    FROM parsed p
    JOIN token_ledger ledger
      ON ledger.run_id = p.run_id
    WHERE ledger.fallback = 0
      AND ledger.total_tokens > 0
      AND ledger.created_at <= p.updated_at_ms
      AND p.run_id <> ''
      AND p.answer_len <> ''
      AND p.answer_len NOT GLOB '*[^0-9]*'
      AND CAST(p.answer_len AS INTEGER) > 0;
  "
)"

weak_or_orphan_answer_receipts="$(
  sql_count "weak or orphan AnswerProduced outcome receipts" "
    WITH valid_work AS (
      SELECT work_item_id, mission_id, status, updated_at_ms, proof_receipts
      FROM work_item
      WHERE COALESCE(updated_at_ms,0) >= ${SINCE_MS}
        AND json_valid(proof_receipts)
    ),
    parsed AS (
      SELECT
        wi.work_item_id,
        wi.updated_at_ms,
        proof.value AS proof_receipt,
        substr(replace(proof.value, 'proof://outcome/AnswerProduced/', ''), 1, instr(replace(proof.value, 'proof://outcome/AnswerProduced/', ''), '?signal=answer_len=') - 1) AS run_id,
        substr(replace(proof.value, 'proof://outcome/AnswerProduced/', ''), instr(replace(proof.value, 'proof://outcome/AnswerProduced/', ''), '?signal=answer_len=') + length('?signal=answer_len=')) AS answer_len
      FROM valid_work wi
      JOIN json_each(wi.proof_receipts) proof
      WHERE wi.status='completed_with_proof'
        AND proof.value LIKE 'proof://outcome/AnswerProduced/%?signal=answer_len=%'
    )
    SELECT COUNT(*)
    FROM parsed p
    WHERE NOT EXISTS (
      SELECT 1
      FROM token_ledger ledger
      WHERE ledger.run_id = p.run_id
        AND ledger.fallback = 0
        AND ledger.total_tokens > 0
        AND ledger.created_at <= p.updated_at_ms
        AND p.run_id <> ''
        AND p.answer_len <> ''
        AND p.answer_len NOT GLOB '*[^0-9]*'
        AND CAST(p.answer_len AS INTEGER) > 0
    );
  "
)"

echo "Outcome proof audit"
echo "  db=${RUST_HUB_DB}"
echo "  since_ms=${SINCE_MS}"
echo "  required_receipts=${REQUIRED_RECEIPTS}"
echo "outcome_answer_receipts=${outcome_answer_receipts}"
echo "joined_answer_receipts=${joined_answer_receipts}"
echo "weak_or_orphan_answer_receipts=${weak_or_orphan_answer_receipts}"
echo "malformed_answer_receipts=${malformed_answer_receipts}"
echo "malformed_json_work_items=${malformed_json_work_items}"

if [ "${malformed_json_work_items}" -ne 0 ]; then
  echo "FAIL - at least one scoped WorkItem has malformed proof_receipts JSON."
  exit 2
fi
if [ "${malformed_answer_receipts}" -ne 0 ]; then
  echo "FAIL - at least one AnswerProduced outcome receipt has an invalid shape."
  exit 2
fi
if [ "${outcome_answer_receipts}" -lt "${REQUIRED_RECEIPTS}" ]; then
  echo "FAIL - insufficient AnswerProduced outcome receipts in the scoped window."
  exit 2
fi
if [ "${weak_or_orphan_answer_receipts}" -ne 0 ]; then
  echo "FAIL - at least one AnswerProduced receipt lacks same-run non-fallback ledger proof, positive answer_len, or causal timestamp ordering."
  exit 2
fi
if [ "${joined_answer_receipts}" -ne "${outcome_answer_receipts}" ]; then
  echo "FAIL - joined AnswerProduced receipt count does not match total scoped AnswerProduced receipts."
  exit 2
fi

echo "PASS - scoped AnswerProduced outcome receipts join to same-run non-fallback ledger proof."
echo "Truth: read-only audit only; not D8 / not soak / not UI-device-channel proof / not GO."
