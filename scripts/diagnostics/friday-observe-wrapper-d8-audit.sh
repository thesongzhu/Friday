#!/usr/bin/env bash
#
# friday-observe-wrapper-d8-audit.sh
# ----------------------------------
# Read-only evidence audit for the observe-wrapper D8 gate.
#
# This script does NOT trigger provider traffic and does NOT read secrets. It
# checks whether the live Rust hub DB/logs currently prove the high-pressure
# observe-wrapper bar:
#
#   live-e2e + operator-triggerable-on-surface + dogfood-stable
#   plus >=20 consecutive real Codex/Claude observed sessions,
#   no serve-loop wedge, no event/data loss, and ledger reconciliation.
#
# Truth boundary:
#   A PASS here is only an audit over already-produced evidence. It does not
#   create the evidence. If FRIDAY_D8_AUDIT_SINCE_MS is not supplied, the audit
#   is intentionally fail-closed to avoid counting old controlled harness rows.
#
set -euo pipefail

readonly RUST_HUB_DB="${FRIDAY_HUB_AGENT_RUN_DB_PATH:-${HOME}/Library/Application Support/Friday/state/rust-hub.sqlite}"
readonly TS_HUB="${FRIDAY_TS_HUB_URL:-http://127.0.0.1:3141}"
readonly RUST_WS_HOST="${FRIDAY_D8_AUDIT_RUST_WS_HOST:-127.0.0.1}"
readonly RUST_WS_PORT="${FRIDAY_D8_AUDIT_RUST_WS_PORT:-48750}"
readonly REQUIRED_SESSIONS="${FRIDAY_D8_AUDIT_REQUIRED_SESSIONS:-20}"
readonly SINCE_MS="${FRIDAY_D8_AUDIT_SINCE_MS:-0}"
readonly ALLOW_UNSCOPED="${FRIDAY_D8_AUDIT_ALLOW_UNSCOPED:-0}"
readonly LOG_LINES="${FRIDAY_D8_AUDIT_LOG_LINES:-2000}"
readonly DETAIL_LIMIT="${FRIDAY_D8_AUDIT_DETAIL_LIMIT:-0}"
readonly TS_STDOUT_LOG="${FRIDAY_TS_STDOUT_LOG:-${HOME}/.friday/launchd/friday.stdout.log}"
readonly TS_STDERR_LOG="${FRIDAY_TS_STDERR_LOG:-${HOME}/.friday/launchd/friday.stderr.log}"
readonly RUST_STDOUT_LOG="${FRIDAY_RUST_STDOUT_LOG:-${HOME}/.friday/launchd/friday-rust-agent-run-ws-server.stdout.log}"
readonly RUST_STDERR_LOG="${FRIDAY_RUST_STDERR_LOG:-${HOME}/.friday/launchd/friday-rust-agent-run-ws-server.stderr.log}"

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

require_positive_int "FRIDAY_D8_AUDIT_REQUIRED_SESSIONS" "${REQUIRED_SESSIONS}"
require_positive_int "FRIDAY_D8_AUDIT_RUST_WS_PORT" "${RUST_WS_PORT}"
require_nonnegative_int "FRIDAY_D8_AUDIT_SINCE_MS" "${SINCE_MS}"
require_positive_int "FRIDAY_D8_AUDIT_LOG_LINES" "${LOG_LINES}"
require_nonnegative_int "FRIDAY_D8_AUDIT_DETAIL_LIMIT" "${DETAIL_LIMIT}"
if [ "${ALLOW_UNSCOPED}" != "0" ] && [ "${ALLOW_UNSCOPED}" != "1" ]; then
  echo "FATAL: FRIDAY_D8_AUDIT_ALLOW_UNSCOPED must be 0 or 1; got '${ALLOW_UNSCOPED}'." >&2
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
require_schema_column "provider_session_event" "provider_event_id"
require_schema_column "provider_session_event" "provider"
require_schema_column "provider_session_event" "observed_at"
require_schema_column "provider_session_event" "token_ledger_ref"
require_schema_column "token_ledger" "ledger_id"
require_schema_column "token_ledger" "provider_kind"
require_schema_column "token_ledger" "fallback"
require_schema_column "token_ledger" "total_tokens"
require_schema_column "token_ledger" "created_at"
require_schema_column "token_ledger" "run_id"
require_schema_column "work_item" "work_item_id"
require_schema_column "work_item" "mission_id"
require_schema_column "work_item" "lane"
require_schema_column "work_item" "target_provider_or_agent"
require_schema_column "work_item" "status"
require_schema_column "work_item" "updated_at_ms"
require_schema_column "work_item" "proof_receipts"
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

log_count() {
  local file="$1"
  local pattern="$2"
  if [ ! -r "${file}" ]; then
    printf '0'
    return
  fi
  tail -n "${LOG_LINES}" "${file}" | LC_ALL=C grep -Eic "${pattern}" || true
}

tcp_port_ok() {
  local host="$1"
  local port="$2"
  (exec 3<>"/dev/tcp/${host}/${port}") >/dev/null 2>&1
}

health_ok=0
if curl -sS --max-time 5 "${TS_HUB%/}/v1/health" >/dev/null 2>&1; then
  health_ok=1
fi

rust_ws_port_ok=0
if tcp_port_ok "${RUST_WS_HOST}" "${RUST_WS_PORT}"; then
  rust_ws_port_ok=1
fi

scoped=1
if [ "${SINCE_MS}" = "0" ] && [ "${ALLOW_UNSCOPED}" != "1" ]; then
  scoped=0
fi

session_links="$(
  sql_count "qualified Codex/Claude provider session links" "
    SELECT COUNT(*)
    FROM provider_session_link
    WHERE (
        (provider = 'codex' AND sync_mode = 'provider_app_server_local')
        OR (provider = 'claude' AND sync_mode = 'friday_local_mirror')
      )
      AND COALESCE(last_provider_seen_at,0) >= ${SINCE_MS};
  "
)"

codex_session_links="$(
  sql_count "qualified Codex provider session links" "
    SELECT COUNT(*)
    FROM provider_session_link
    WHERE provider = 'codex'
      AND sync_mode = 'provider_app_server_local'
      AND COALESCE(last_provider_seen_at,0) >= ${SINCE_MS};
  "
)"

claude_session_links="$(
  sql_count "qualified Claude provider session links" "
    SELECT COUNT(*)
    FROM provider_session_link
    WHERE provider = 'claude'
      AND sync_mode = 'friday_local_mirror'
      AND COALESCE(last_provider_seen_at,0) >= ${SINCE_MS};
  "
)"

unqualified_session_links="$(
  sql_count "unqualified Codex/Claude provider session links" "
    SELECT COUNT(*)
    FROM provider_session_link
    WHERE provider IN ('codex','claude')
      AND COALESCE(last_provider_seen_at,0) >= ${SINCE_MS}
      AND NOT (
        (provider = 'codex' AND sync_mode = 'provider_app_server_local')
        OR (provider = 'claude' AND sync_mode = 'friday_local_mirror')
      );
  "
)"

event_sessions="$(
  sql_count "Codex/Claude event sessions" "
    SELECT COUNT(DISTINCT e.friday_session_id)
    FROM provider_session_event e
    JOIN provider_session_link l
      ON l.friday_session_id = e.friday_session_id
     AND l.provider = e.provider
    WHERE (
        (l.provider = 'codex' AND l.sync_mode = 'provider_app_server_local')
        OR (l.provider = 'claude' AND l.sync_mode = 'friday_local_mirror')
      )
      AND e.observed_at >= ${SINCE_MS};
  "
)"

linked_event_sessions="$(
  sql_count "Codex/Claude linked event sessions" "
    SELECT COUNT(DISTINCT e.friday_session_id)
    FROM provider_session_event e
    JOIN provider_session_link l
      ON l.friday_session_id = e.friday_session_id
     AND l.provider = e.provider
    JOIN token_ledger ledger
      ON ledger.ledger_id = e.token_ledger_ref
    WHERE (
        (l.provider = 'codex' AND l.sync_mode = 'provider_app_server_local')
        OR (l.provider = 'claude' AND l.sync_mode = 'friday_local_mirror')
      )
      AND e.observed_at >= ${SINCE_MS}
      AND COALESCE(e.token_ledger_ref,'') <> ''
      AND ledger.fallback = 0
      AND ledger.total_tokens > 0
      AND (
        (e.provider = 'codex' AND ledger.provider_kind = 'codex')
        OR (e.provider = 'claude' AND ledger.provider_kind IN ('claude','anthropic'))
      );
  "
)"

events_total="$(
  sql_count "Codex/Claude provider events" "
    SELECT COUNT(*)
    FROM provider_session_event e
    JOIN provider_session_link l
      ON l.friday_session_id = e.friday_session_id
     AND l.provider = e.provider
    WHERE (
        (l.provider = 'codex' AND l.sync_mode = 'provider_app_server_local')
        OR (l.provider = 'claude' AND l.sync_mode = 'friday_local_mirror')
      )
      AND e.observed_at >= ${SINCE_MS};
  "
)"

linked_events="$(
  sql_count "Codex/Claude linked provider events" "
    SELECT COUNT(*)
    FROM provider_session_event e
    JOIN provider_session_link l
      ON l.friday_session_id = e.friday_session_id
     AND l.provider = e.provider
    JOIN token_ledger ledger
      ON ledger.ledger_id = e.token_ledger_ref
    WHERE (
        (l.provider = 'codex' AND l.sync_mode = 'provider_app_server_local')
        OR (l.provider = 'claude' AND l.sync_mode = 'friday_local_mirror')
      )
      AND e.observed_at >= ${SINCE_MS}
      AND COALESCE(e.token_ledger_ref,'') <> ''
      AND ledger.fallback = 0
      AND ledger.total_tokens > 0
      AND (
        (e.provider = 'codex' AND ledger.provider_kind = 'codex')
        OR (e.provider = 'claude' AND ledger.provider_kind IN ('claude','anthropic'))
      );
  "
)"

unlinked_events="$(
  sql_count "Codex/Claude unlinked provider events" "
    SELECT COUNT(*)
    FROM provider_session_event e
    JOIN provider_session_link l
      ON l.friday_session_id = e.friday_session_id
     AND l.provider = e.provider
    WHERE (
        (l.provider = 'codex' AND l.sync_mode = 'provider_app_server_local')
        OR (l.provider = 'claude' AND l.sync_mode = 'friday_local_mirror')
      )
      AND e.observed_at >= ${SINCE_MS}
      AND COALESCE(e.token_ledger_ref,'') = '';
  "
)"

orphan_ledger_refs="$(
  sql_count "provider event orphan token ledger refs" "
    SELECT COUNT(*)
    FROM provider_session_event e
    JOIN provider_session_link session_link
      ON session_link.friday_session_id = e.friday_session_id
     AND session_link.provider = e.provider
    LEFT JOIN token_ledger l ON l.ledger_id = e.token_ledger_ref
    WHERE (
        (session_link.provider = 'codex' AND session_link.sync_mode = 'provider_app_server_local')
        OR (session_link.provider = 'claude' AND session_link.sync_mode = 'friday_local_mirror')
      )
      AND e.observed_at >= ${SINCE_MS}
      AND COALESCE(e.token_ledger_ref,'') <> ''
      AND l.ledger_id IS NULL;
  "
)"

invalid_ledger_refs="$(
  sql_count "provider event invalid token ledger refs" "
    SELECT COUNT(*)
    FROM provider_session_event e
    JOIN provider_session_link session_link
      ON session_link.friday_session_id = e.friday_session_id
     AND session_link.provider = e.provider
    JOIN token_ledger ledger
      ON ledger.ledger_id = e.token_ledger_ref
    WHERE (
        (session_link.provider = 'codex' AND session_link.sync_mode = 'provider_app_server_local')
        OR (session_link.provider = 'claude' AND session_link.sync_mode = 'friday_local_mirror')
      )
      AND e.observed_at >= ${SINCE_MS}
      AND COALESCE(e.token_ledger_ref,'') <> ''
      AND (
        ledger.fallback <> 0
        OR ledger.total_tokens <= 0
        OR NOT (
          (e.provider = 'codex' AND ledger.provider_kind = 'codex')
          OR (e.provider = 'claude' AND ledger.provider_kind IN ('claude','anthropic'))
        )
      );
  "
)"

duplicate_session_run_ids="$(
  sql_count "duplicate token ledger run ids across provider sessions" "
    SELECT COUNT(*)
    FROM (
      SELECT ledger.run_id
      FROM provider_session_link l
      JOIN provider_session_event e
        ON e.friday_session_id = l.friday_session_id
       AND e.provider = l.provider
      JOIN token_ledger ledger
        ON ledger.ledger_id = e.token_ledger_ref
      WHERE (
          (l.provider = 'codex' AND l.sync_mode = 'provider_app_server_local')
          OR (l.provider = 'claude' AND l.sync_mode = 'friday_local_mirror')
        )
        AND COALESCE(l.last_provider_seen_at,0) >= ${SINCE_MS}
        AND e.observed_at >= ${SINCE_MS}
        AND COALESCE(e.token_ledger_ref,'') <> ''
        AND COALESCE(ledger.run_id,'') <> ''
        AND ledger.fallback = 0
        AND ledger.total_tokens > 0
        AND (
          (e.provider = 'codex' AND ledger.provider_kind = 'codex')
          OR (e.provider = 'claude' AND ledger.provider_kind IN ('claude','anthropic'))
        )
      GROUP BY ledger.run_id
      HAVING COUNT(DISTINCT l.friday_session_id) > 1
    );
  "
)"

unreferenced_ledger_rows="$(
  sql_count "Codex/Claude ledger rows without provider event refs" "
    SELECT COUNT(*)
    FROM token_ledger ledger
    LEFT JOIN provider_session_event event
      ON event.token_ledger_ref = ledger.ledger_id
     AND event.provider IN ('codex','claude')
     AND event.observed_at >= ${SINCE_MS}
    WHERE ledger.provider_kind IN ('codex','claude','anthropic')
      AND ledger.fallback = 0
      AND ledger.total_tokens > 0
      AND ledger.created_at >= ${SINCE_MS}
      AND event.provider_event_id IS NULL;
  "
)"

unproved_linked_session_runs="$(
  sql_count "ledger-linked provider session runs without completed WorkItem proof" "
    WITH linked_runs AS (
      SELECT
        l.friday_session_id AS friday_session_id,
        e.provider AS provider,
        ledger.run_id AS run_id,
        MAX(ledger.created_at) AS ledger_created_at
      FROM provider_session_link l
      JOIN provider_session_event e
        ON e.friday_session_id = l.friday_session_id
       AND e.provider = l.provider
      JOIN token_ledger ledger
        ON ledger.ledger_id = e.token_ledger_ref
      WHERE (
          (l.provider = 'codex' AND l.sync_mode = 'provider_app_server_local')
          OR (l.provider = 'claude' AND l.sync_mode = 'friday_local_mirror')
        )
        AND COALESCE(l.last_provider_seen_at,0) >= ${SINCE_MS}
        AND e.observed_at >= ${SINCE_MS}
        AND COALESCE(e.token_ledger_ref,'') <> ''
        AND COALESCE(ledger.run_id,'') <> ''
        AND ledger.fallback = 0
        AND ledger.total_tokens > 0
        AND (
          (e.provider = 'codex' AND ledger.provider_kind = 'codex')
          OR (e.provider = 'claude' AND ledger.provider_kind IN ('claude','anthropic'))
        )
      GROUP BY l.friday_session_id, e.provider, ledger.run_id
    )
    SELECT COUNT(*)
    FROM linked_runs r
    WHERE NOT EXISTS (
      SELECT 1
      FROM work_item w
      JOIN json_each(w.proof_receipts) proof
        ON proof.value = 'friday://agent-run/' || r.run_id
      WHERE (w.lane = r.provider OR w.target_provider_or_agent = r.provider)
        AND w.status = 'completed_with_proof'
        AND w.updated_at_ms >= ${SINCE_MS}
        AND w.updated_at_ms >= r.ledger_created_at
    );
  "
)"

ledger_rows="$(
  sql_count "Codex/Claude ledger rows" "
    SELECT COUNT(*)
    FROM token_ledger
    WHERE provider_kind IN ('codex','claude','anthropic')
      AND fallback = 0
      AND total_tokens > 0
      AND created_at >= ${SINCE_MS};
  "
)"

codex_ledger_rows="$(
  sql_count "Codex ledger rows" "
    SELECT COUNT(*)
    FROM token_ledger
    WHERE provider_kind = 'codex'
      AND fallback = 0
      AND total_tokens > 0
      AND created_at >= ${SINCE_MS};
  "
)"

claude_ledger_rows="$(
  sql_count "Claude/Anthropic ledger rows" "
    SELECT COUNT(*)
    FROM token_ledger
    WHERE provider_kind IN ('claude','anthropic')
      AND fallback = 0
      AND total_tokens > 0
      AND created_at >= ${SINCE_MS};
  "
)"

completed_work_items="$(
  sql_count "Codex/Claude completed work items" "
    SELECT COUNT(*)
    FROM work_item
    WHERE (lane IN ('codex','claude') OR target_provider_or_agent IN ('codex','claude'))
      AND status = 'completed_with_proof'
      AND updated_at_ms >= ${SINCE_MS};
  "
)"

work_items_total="$(
  sql_count "Codex/Claude work items" "
    SELECT COUNT(*)
    FROM work_item
    WHERE (lane IN ('codex','claude') OR target_provider_or_agent IN ('codex','claude'))
      AND updated_at_ms >= ${SINCE_MS};
  "
)"

claimed_process_observations="$(
  sql_count "claimed Codex/Claude process observations" "
    SELECT COUNT(*)
    FROM process_observation
    WHERE process_kind IN ('codex_app_server','claude')
      AND ownership_status = 'friday_owned_claimed'
      AND observed_at_ms >= ${SINCE_MS};
  "
)"

claimed_codex_process_observations="$(
  sql_count "claimed Codex process observations" "
    SELECT COUNT(*)
    FROM process_observation
    WHERE process_kind = 'codex_app_server'
      AND ownership_status = 'friday_owned_claimed'
      AND observed_at_ms >= ${SINCE_MS};
  "
)"

claimed_claude_process_observations="$(
  sql_count "claimed Claude process observations" "
    SELECT COUNT(*)
    FROM process_observation
    WHERE process_kind = 'claude'
      AND ownership_status = 'friday_owned_claimed'
      AND observed_at_ms >= ${SINCE_MS};
  "
)"

last_n_process_proved_sessions="$(
  sql_count "last N linked sessions with provider process proof" "
    WITH sessions AS (
      SELECT
        l.friday_session_id AS friday_session_id,
        l.provider AS provider,
        COALESCE(MAX(e.observed_at), l.last_provider_seen_at, 0) AS seen_at
      FROM provider_session_link l
      LEFT JOIN provider_session_event e
        ON e.friday_session_id = l.friday_session_id
       AND e.provider = l.provider
       AND e.observed_at >= ${SINCE_MS}
      WHERE (
          (l.provider = 'codex' AND l.sync_mode = 'provider_app_server_local')
          OR (l.provider = 'claude' AND l.sync_mode = 'friday_local_mirror')
        )
        AND COALESCE(l.last_provider_seen_at,0) >= ${SINCE_MS}
      GROUP BY l.friday_session_id, l.provider
    ),
    last_n AS (
      SELECT *
      FROM sessions
      ORDER BY seen_at DESC, friday_session_id DESC
      LIMIT ${REQUIRED_SESSIONS}
    )
    SELECT COUNT(DISTINCT n.friday_session_id)
    FROM last_n n
    JOIN process_observation observation
      ON observation.ownership_status = 'friday_owned_claimed'
     AND observation.observed_at_ms >= ${SINCE_MS}
     AND observation.observed_at_ms <= n.seen_at
     AND (
       (
         n.provider = 'codex'
         AND observation.process_kind = 'codex_app_server'
         AND observation.port_bindings LIKE '%\"friday://provider-session/' || n.friday_session_id || '\"%'
       )
       OR (n.provider = 'claude' AND observation.process_kind = 'claude')
     );
  "
)"

last_n_claim_bound_process_proved_sessions="$(
  sql_count "last N linked sessions with claim-bound provider process proof" "
    WITH sessions AS (
      SELECT
        l.friday_session_id AS friday_session_id,
        l.provider AS provider,
        COALESCE(MAX(e.observed_at), l.last_provider_seen_at, 0) AS seen_at
      FROM provider_session_link l
      LEFT JOIN provider_session_event e
        ON e.friday_session_id = l.friday_session_id
       AND e.provider = l.provider
       AND e.observed_at >= ${SINCE_MS}
      WHERE (
          (l.provider = 'codex' AND l.sync_mode = 'provider_app_server_local')
          OR (l.provider = 'claude' AND l.sync_mode = 'friday_local_mirror')
        )
        AND COALESCE(l.last_provider_seen_at,0) >= ${SINCE_MS}
      GROUP BY l.friday_session_id, l.provider
    ),
    last_n AS (
      SELECT *
      FROM sessions
      ORDER BY seen_at DESC, friday_session_id DESC
      LIMIT ${REQUIRED_SESSIONS}
    ),
    last_n_runs AS (
      SELECT DISTINCT
        n.friday_session_id AS friday_session_id,
        n.provider AS provider,
        n.seen_at AS seen_at,
        ledger.run_id AS run_id,
        ledger.created_at AS ledger_created_at
      FROM last_n n
      JOIN provider_session_event e
        ON e.friday_session_id = n.friday_session_id
       AND e.provider = n.provider
       AND e.observed_at >= ${SINCE_MS}
       AND COALESCE(e.token_ledger_ref,'') <> ''
      JOIN token_ledger ledger
        ON ledger.ledger_id = e.token_ledger_ref
       AND COALESCE(ledger.run_id,'') <> ''
       AND ledger.fallback = 0
       AND ledger.total_tokens > 0
       AND (
         (n.provider = 'codex' AND ledger.provider_kind = 'codex')
         OR (n.provider = 'claude' AND ledger.provider_kind IN ('claude','anthropic'))
       )
    ),
    matching_proofs AS (
      SELECT DISTINCT
        r.friday_session_id AS friday_session_id,
        r.provider AS provider,
        r.seen_at AS seen_at,
        w.work_item_id AS work_item_id
      FROM last_n_runs r
      JOIN work_item w
        ON (w.lane = r.provider OR w.target_provider_or_agent = r.provider)
       AND w.status = 'completed_with_proof'
       AND w.updated_at_ms >= ${SINCE_MS}
       AND w.updated_at_ms >= r.ledger_created_at
      JOIN json_each(w.proof_receipts) proof
        ON proof.value = 'friday://agent-run/' || r.run_id
    )
    SELECT COUNT(DISTINCT p.friday_session_id)
    FROM matching_proofs p
    JOIN workspace_claim claim
      ON claim.work_item_id = p.work_item_id
     AND claim.claim_kind IN ('process','provider_session')
    JOIN process_observation observation
      ON observation.matched_claim_id = claim.claim_id
     AND observation.ownership_status = 'friday_owned_claimed'
     AND observation.observed_at_ms >= ${SINCE_MS}
     AND observation.observed_at_ms <= p.seen_at
     AND (
       (
         p.provider = 'codex'
         AND observation.process_kind = 'codex_app_server'
         AND observation.port_bindings LIKE '%\"friday://provider-session/' || p.friday_session_id || '\"%'
       )
       OR (p.provider = 'claude' AND observation.process_kind = 'claude')
     );
  "
)"

last_n_linked_sessions="$(
  sql_count "last N linked sessions" "
    WITH sessions AS (
      SELECT
        l.friday_session_id AS friday_session_id,
        l.provider AS provider,
        COALESCE(MAX(e.observed_at), l.last_provider_seen_at, 0) AS seen_at,
        COUNT(e.provider_event_id) AS event_count,
        SUM(
          CASE
            WHEN COALESCE(e.token_ledger_ref,'') <> ''
             AND ledger.ledger_id IS NOT NULL
             AND ledger.fallback = 0
             AND ledger.total_tokens > 0
             AND (
               (l.provider = 'codex' AND ledger.provider_kind = 'codex')
               OR (l.provider = 'claude' AND ledger.provider_kind IN ('claude','anthropic'))
             )
            THEN 1 ELSE 0
          END
        ) AS linked_event_count
      FROM provider_session_link l
      LEFT JOIN provider_session_event e
        ON e.friday_session_id = l.friday_session_id
       AND e.provider = l.provider
       AND e.observed_at >= ${SINCE_MS}
      LEFT JOIN token_ledger ledger
        ON ledger.ledger_id = e.token_ledger_ref
      WHERE (
          (l.provider = 'codex' AND l.sync_mode = 'provider_app_server_local')
          OR (l.provider = 'claude' AND l.sync_mode = 'friday_local_mirror')
        )
        AND COALESCE(l.last_provider_seen_at,0) >= ${SINCE_MS}
      GROUP BY l.friday_session_id, l.provider
    ),
    last_n AS (
      SELECT *
      FROM sessions
      ORDER BY seen_at DESC, friday_session_id DESC
      LIMIT ${REQUIRED_SESSIONS}
    )
    SELECT COUNT(*)
    FROM last_n
    WHERE event_count > 0
      AND linked_event_count > 0;
  "
)"

incomplete_session_links="$(
  sql_count "Codex/Claude provider session links without linked events" "
    WITH sessions AS (
      SELECT
        l.friday_session_id AS friday_session_id,
        l.provider AS provider,
        COUNT(e.provider_event_id) AS event_count,
        SUM(
          CASE
            WHEN COALESCE(e.token_ledger_ref,'') <> ''
             AND ledger.ledger_id IS NOT NULL
             AND ledger.fallback = 0
             AND ledger.total_tokens > 0
             AND (
               (l.provider = 'codex' AND ledger.provider_kind = 'codex')
               OR (l.provider = 'claude' AND ledger.provider_kind IN ('claude','anthropic'))
             )
            THEN 1 ELSE 0
          END
        ) AS linked_event_count
      FROM provider_session_link l
      LEFT JOIN provider_session_event e
        ON e.friday_session_id = l.friday_session_id
       AND e.provider = l.provider
       AND e.observed_at >= ${SINCE_MS}
      LEFT JOIN token_ledger ledger
        ON ledger.ledger_id = e.token_ledger_ref
      WHERE (
          (l.provider = 'codex' AND l.sync_mode = 'provider_app_server_local')
          OR (l.provider = 'claude' AND l.sync_mode = 'friday_local_mirror')
        )
        AND COALESCE(l.last_provider_seen_at,0) >= ${SINCE_MS}
      GROUP BY l.friday_session_id, l.provider
    )
    SELECT COUNT(*)
    FROM sessions
    WHERE event_count = 0
       OR linked_event_count = 0;
  "
)"

last_n_completed_proof_sessions="$(
  sql_count "last N linked sessions with matching WorkItem proof" "
    WITH sessions AS (
      SELECT
        l.friday_session_id AS friday_session_id,
        l.provider AS provider,
        COALESCE(MAX(e.observed_at), l.last_provider_seen_at, 0) AS seen_at,
        COUNT(e.provider_event_id) AS event_count,
        SUM(
          CASE
            WHEN COALESCE(e.token_ledger_ref,'') <> ''
             AND ledger.ledger_id IS NOT NULL
             AND ledger.fallback = 0
             AND ledger.total_tokens > 0
             AND (
               (l.provider = 'codex' AND ledger.provider_kind = 'codex')
               OR (l.provider = 'claude' AND ledger.provider_kind IN ('claude','anthropic'))
             )
            THEN 1 ELSE 0
          END
        ) AS linked_event_count
      FROM provider_session_link l
      LEFT JOIN provider_session_event e
        ON e.friday_session_id = l.friday_session_id
       AND e.provider = l.provider
       AND e.observed_at >= ${SINCE_MS}
      LEFT JOIN token_ledger ledger
        ON ledger.ledger_id = e.token_ledger_ref
      WHERE (
          (l.provider = 'codex' AND l.sync_mode = 'provider_app_server_local')
          OR (l.provider = 'claude' AND l.sync_mode = 'friday_local_mirror')
        )
        AND COALESCE(l.last_provider_seen_at,0) >= ${SINCE_MS}
      GROUP BY l.friday_session_id, l.provider
    ),
    last_n AS (
      SELECT *
      FROM sessions
      ORDER BY seen_at DESC, friday_session_id DESC
      LIMIT ${REQUIRED_SESSIONS}
    ),
    last_n_runs AS (
      SELECT DISTINCT
        n.friday_session_id AS friday_session_id,
        n.provider AS provider,
        ledger.run_id AS run_id,
        ledger.created_at AS ledger_created_at
      FROM last_n n
      JOIN provider_session_event e
        ON e.friday_session_id = n.friday_session_id
       AND e.provider = n.provider
       AND e.observed_at >= ${SINCE_MS}
       AND COALESCE(e.token_ledger_ref,'') <> ''
      JOIN token_ledger ledger
        ON ledger.ledger_id = e.token_ledger_ref
       AND COALESCE(ledger.run_id,'') <> ''
       AND ledger.fallback = 0
       AND ledger.total_tokens > 0
       AND (
         (n.provider = 'codex' AND ledger.provider_kind = 'codex')
         OR (n.provider = 'claude' AND ledger.provider_kind IN ('claude','anthropic'))
       )
    )
    SELECT COUNT(DISTINCT r.friday_session_id)
    FROM last_n_runs r
    JOIN work_item w
      ON (w.lane = r.provider OR w.target_provider_or_agent = r.provider)
     AND w.status = 'completed_with_proof'
     AND w.updated_at_ms >= ${SINCE_MS}
     AND w.updated_at_ms >= r.ledger_created_at
    JOIN json_each(w.proof_receipts) proof
      ON proof.value = 'friday://agent-run/' || r.run_id;
  "
)"

last_n_completed_proof_work_items="$(
  sql_count "last N linked sessions with distinct matching WorkItem proof" "
    WITH sessions AS (
      SELECT
        l.friday_session_id AS friday_session_id,
        l.provider AS provider,
        COALESCE(MAX(e.observed_at), l.last_provider_seen_at, 0) AS seen_at,
        COUNT(e.provider_event_id) AS event_count,
        SUM(
          CASE
            WHEN COALESCE(e.token_ledger_ref,'') <> ''
             AND ledger.ledger_id IS NOT NULL
             AND ledger.fallback = 0
             AND ledger.total_tokens > 0
             AND (
               (l.provider = 'codex' AND ledger.provider_kind = 'codex')
               OR (l.provider = 'claude' AND ledger.provider_kind IN ('claude','anthropic'))
             )
            THEN 1 ELSE 0
          END
        ) AS linked_event_count
      FROM provider_session_link l
      LEFT JOIN provider_session_event e
        ON e.friday_session_id = l.friday_session_id
       AND e.provider = l.provider
       AND e.observed_at >= ${SINCE_MS}
      LEFT JOIN token_ledger ledger
        ON ledger.ledger_id = e.token_ledger_ref
      WHERE (
          (l.provider = 'codex' AND l.sync_mode = 'provider_app_server_local')
          OR (l.provider = 'claude' AND l.sync_mode = 'friday_local_mirror')
        )
        AND COALESCE(l.last_provider_seen_at,0) >= ${SINCE_MS}
      GROUP BY l.friday_session_id, l.provider
    ),
    last_n AS (
      SELECT *
      FROM sessions
      ORDER BY seen_at DESC, friday_session_id DESC
      LIMIT ${REQUIRED_SESSIONS}
    ),
    last_n_runs AS (
      SELECT DISTINCT
        n.friday_session_id AS friday_session_id,
        n.provider AS provider,
        ledger.run_id AS run_id,
        ledger.created_at AS ledger_created_at
      FROM last_n n
      JOIN provider_session_event e
        ON e.friday_session_id = n.friday_session_id
       AND e.provider = n.provider
       AND e.observed_at >= ${SINCE_MS}
       AND COALESCE(e.token_ledger_ref,'') <> ''
      JOIN token_ledger ledger
        ON ledger.ledger_id = e.token_ledger_ref
       AND COALESCE(ledger.run_id,'') <> ''
       AND ledger.fallback = 0
       AND ledger.total_tokens > 0
       AND (
         (n.provider = 'codex' AND ledger.provider_kind = 'codex')
         OR (n.provider = 'claude' AND ledger.provider_kind IN ('claude','anthropic'))
       )
    )
    SELECT COUNT(DISTINCT w.work_item_id)
    FROM last_n_runs r
    JOIN work_item w
      ON (w.lane = r.provider OR w.target_provider_or_agent = r.provider)
     AND w.status = 'completed_with_proof'
     AND w.updated_at_ms >= ${SINCE_MS}
     AND w.updated_at_ms >= r.ledger_created_at
    JOIN json_each(w.proof_receipts) proof
      ON proof.value = 'friday://agent-run/' || r.run_id;
  "
)"

multi_session_proof_work_items="$(
  sql_count "matching WorkItem proofs reused across last N linked sessions" "
    WITH sessions AS (
      SELECT
        l.friday_session_id AS friday_session_id,
        l.provider AS provider,
        COALESCE(MAX(e.observed_at), l.last_provider_seen_at, 0) AS seen_at,
        COUNT(e.provider_event_id) AS event_count,
        SUM(
          CASE
            WHEN COALESCE(e.token_ledger_ref,'') <> ''
             AND ledger.ledger_id IS NOT NULL
             AND ledger.fallback = 0
             AND ledger.total_tokens > 0
             AND (
               (l.provider = 'codex' AND ledger.provider_kind = 'codex')
               OR (l.provider = 'claude' AND ledger.provider_kind IN ('claude','anthropic'))
             )
            THEN 1 ELSE 0
          END
        ) AS linked_event_count
      FROM provider_session_link l
      LEFT JOIN provider_session_event e
        ON e.friday_session_id = l.friday_session_id
       AND e.provider = l.provider
       AND e.observed_at >= ${SINCE_MS}
      LEFT JOIN token_ledger ledger
        ON ledger.ledger_id = e.token_ledger_ref
      WHERE (
          (l.provider = 'codex' AND l.sync_mode = 'provider_app_server_local')
          OR (l.provider = 'claude' AND l.sync_mode = 'friday_local_mirror')
        )
        AND COALESCE(l.last_provider_seen_at,0) >= ${SINCE_MS}
      GROUP BY l.friday_session_id, l.provider
    ),
    last_n AS (
      SELECT *
      FROM sessions
      ORDER BY seen_at DESC, friday_session_id DESC
      LIMIT ${REQUIRED_SESSIONS}
    ),
    last_n_runs AS (
      SELECT DISTINCT
        n.friday_session_id AS friday_session_id,
        n.provider AS provider,
        ledger.run_id AS run_id,
        ledger.created_at AS ledger_created_at
      FROM last_n n
      JOIN provider_session_event e
        ON e.friday_session_id = n.friday_session_id
       AND e.provider = n.provider
       AND e.observed_at >= ${SINCE_MS}
       AND COALESCE(e.token_ledger_ref,'') <> ''
      JOIN token_ledger ledger
        ON ledger.ledger_id = e.token_ledger_ref
       AND COALESCE(ledger.run_id,'') <> ''
       AND ledger.fallback = 0
       AND ledger.total_tokens > 0
       AND (
         (n.provider = 'codex' AND ledger.provider_kind = 'codex')
         OR (n.provider = 'claude' AND ledger.provider_kind IN ('claude','anthropic'))
       )
    ),
    matching_work_item_sessions AS (
      SELECT DISTINCT
        w.work_item_id AS work_item_id,
        r.friday_session_id AS friday_session_id
      FROM last_n_runs r
      JOIN work_item w
        ON (w.lane = r.provider OR w.target_provider_or_agent = r.provider)
       AND w.status = 'completed_with_proof'
       AND w.updated_at_ms >= ${SINCE_MS}
       AND w.updated_at_ms >= r.ledger_created_at
      JOIN json_each(w.proof_receipts) proof
        ON proof.value = 'friday://agent-run/' || r.run_id
    )
    SELECT COUNT(*)
    FROM (
      SELECT work_item_id
      FROM matching_work_item_sessions
      GROUP BY work_item_id
      HAVING COUNT(DISTINCT friday_session_id) > 1
    );
  "
)"

last_n_surface_bound_proof_sessions="$(
  sql_count "last N linked sessions with surface-bound WorkItem proof" "
    WITH sessions AS (
      SELECT
        l.friday_session_id AS friday_session_id,
        l.provider AS provider,
        COALESCE(MAX(e.observed_at), l.last_provider_seen_at, 0) AS seen_at,
        COUNT(e.provider_event_id) AS event_count,
        SUM(
          CASE
            WHEN COALESCE(e.token_ledger_ref,'') <> ''
             AND ledger.ledger_id IS NOT NULL
             AND ledger.fallback = 0
             AND ledger.total_tokens > 0
             AND (
               (l.provider = 'codex' AND ledger.provider_kind = 'codex')
               OR (l.provider = 'claude' AND ledger.provider_kind IN ('claude','anthropic'))
             )
            THEN 1 ELSE 0
          END
        ) AS linked_event_count
      FROM provider_session_link l
      LEFT JOIN provider_session_event e
        ON e.friday_session_id = l.friday_session_id
       AND e.provider = l.provider
       AND e.observed_at >= ${SINCE_MS}
      LEFT JOIN token_ledger ledger
        ON ledger.ledger_id = e.token_ledger_ref
      WHERE (
          (l.provider = 'codex' AND l.sync_mode = 'provider_app_server_local')
          OR (l.provider = 'claude' AND l.sync_mode = 'friday_local_mirror')
        )
        AND COALESCE(l.last_provider_seen_at,0) >= ${SINCE_MS}
      GROUP BY l.friday_session_id, l.provider
    ),
    last_n AS (
      SELECT *
      FROM sessions
      ORDER BY seen_at DESC, friday_session_id DESC
      LIMIT ${REQUIRED_SESSIONS}
    ),
    last_n_runs AS (
      SELECT DISTINCT
        n.friday_session_id AS friday_session_id,
        n.provider AS provider,
        ledger.run_id AS run_id,
        ledger.created_at AS ledger_created_at
      FROM last_n n
      JOIN provider_session_event e
        ON e.friday_session_id = n.friday_session_id
       AND e.provider = n.provider
       AND e.observed_at >= ${SINCE_MS}
       AND COALESCE(e.token_ledger_ref,'') <> ''
      JOIN token_ledger ledger
        ON ledger.ledger_id = e.token_ledger_ref
       AND COALESCE(ledger.run_id,'') <> ''
       AND ledger.fallback = 0
       AND ledger.total_tokens > 0
       AND (
         (n.provider = 'codex' AND ledger.provider_kind = 'codex')
         OR (n.provider = 'claude' AND ledger.provider_kind IN ('claude','anthropic'))
       )
    )
    SELECT COUNT(DISTINCT r.friday_session_id)
    FROM last_n_runs r
    JOIN work_item w
      ON (w.lane = r.provider OR w.target_provider_or_agent = r.provider)
     AND w.status = 'completed_with_proof'
     AND w.updated_at_ms >= ${SINCE_MS}
     AND w.updated_at_ms >= r.ledger_created_at
    JOIN json_each(w.proof_receipts) proof
      ON proof.value = 'friday://agent-run/' || r.run_id
    JOIN mission m
      ON m.mission_id = w.mission_id
     AND m.created_at_ms >= ${SINCE_MS}
     AND m.created_at_ms <= w.updated_at_ms
    JOIN surface_thread surface
      ON surface.mission_id = w.mission_id
     AND surface.friday_conversation_id = m.friday_conversation_id
     AND surface.created_at_ms >= ${SINCE_MS}
     AND surface.created_at_ms <= w.updated_at_ms
     AND surface.surface_kind = 'mobile'
     AND COALESCE(surface.delivery_route,'') <> '';
  "
)"

surface_unbound_proof_session_runs="$(
  sql_count "ledger-linked provider session runs with proof but without surface-bound proof" "
    WITH linked_runs AS (
      SELECT
        l.friday_session_id AS friday_session_id,
        e.provider AS provider,
        ledger.run_id AS run_id,
        MAX(ledger.created_at) AS ledger_created_at
      FROM provider_session_link l
      JOIN provider_session_event e
        ON e.friday_session_id = l.friday_session_id
       AND e.provider = l.provider
      JOIN token_ledger ledger
        ON ledger.ledger_id = e.token_ledger_ref
      WHERE (
          (l.provider = 'codex' AND l.sync_mode = 'provider_app_server_local')
          OR (l.provider = 'claude' AND l.sync_mode = 'friday_local_mirror')
        )
        AND COALESCE(l.last_provider_seen_at,0) >= ${SINCE_MS}
        AND e.observed_at >= ${SINCE_MS}
        AND COALESCE(e.token_ledger_ref,'') <> ''
        AND COALESCE(ledger.run_id,'') <> ''
        AND ledger.fallback = 0
        AND ledger.total_tokens > 0
        AND (
          (e.provider = 'codex' AND ledger.provider_kind = 'codex')
          OR (e.provider = 'claude' AND ledger.provider_kind IN ('claude','anthropic'))
        )
      GROUP BY l.friday_session_id, e.provider, ledger.run_id
    )
    SELECT COUNT(*)
    FROM linked_runs r
    WHERE EXISTS (
      SELECT 1
      FROM work_item w
      JOIN json_each(w.proof_receipts) proof
        ON proof.value = 'friday://agent-run/' || r.run_id
      WHERE (w.lane = r.provider OR w.target_provider_or_agent = r.provider)
        AND w.status = 'completed_with_proof'
        AND w.updated_at_ms >= ${SINCE_MS}
        AND w.updated_at_ms >= r.ledger_created_at
    )
    AND NOT EXISTS (
      SELECT 1
      FROM work_item w
      JOIN json_each(w.proof_receipts) proof
        ON proof.value = 'friday://agent-run/' || r.run_id
      JOIN mission m
        ON m.mission_id = w.mission_id
       AND m.created_at_ms >= ${SINCE_MS}
       AND m.created_at_ms <= w.updated_at_ms
      JOIN surface_thread surface
       ON surface.mission_id = w.mission_id
       AND surface.friday_conversation_id = m.friday_conversation_id
       AND surface.created_at_ms >= ${SINCE_MS}
       AND surface.created_at_ms <= w.updated_at_ms
       AND surface.surface_kind = 'mobile'
       AND COALESCE(surface.delivery_route,'') <> ''
      WHERE (w.lane = r.provider OR w.target_provider_or_agent = r.provider)
        AND w.status = 'completed_with_proof'
        AND w.updated_at_ms >= ${SINCE_MS}
        AND w.updated_at_ms >= r.ledger_created_at
    );
  "
)"

wedge_like_logs=0
for log_file in "${TS_STDOUT_LOG}" "${TS_STDERR_LOG}" "${RUST_STDOUT_LOG}" "${RUST_STDERR_LOG}"; do
  count="$(log_count "${log_file}" 'serve-loop|wedge|thread .*panicked|panic|uncaught|unhandled')"
  wedge_like_logs=$((wedge_like_logs + count))
done

pass=1
fail_reasons=()
if [ "${health_ok}" -ne 1 ]; then
  pass=0
  fail_reasons+=("TS health did not respond ok")
fi
if [ "${rust_ws_port_ok}" -ne 1 ]; then
  pass=0
  fail_reasons+=("Rust agent-run WS port did not accept a local TCP connection")
fi
if [ "${scoped}" -ne 1 ]; then
  pass=0
  fail_reasons+=("FRIDAY_D8_AUDIT_SINCE_MS not supplied; unscoped audit cannot prove current D8")
fi
if [ "${session_links}" -lt "${REQUIRED_SESSIONS}" ]; then
  pass=0
  fail_reasons+=("qualified provider_session_link count below required sessions")
fi
if [ "${unqualified_session_links}" -ne 0 ]; then
  pass=0
  fail_reasons+=("scoped provider_session_link rows use non-D8 sync_mode values")
fi
if [ "${linked_event_sessions}" -lt "${REQUIRED_SESSIONS}" ]; then
  pass=0
  fail_reasons+=("distinct linked provider-event sessions below required sessions")
fi
if [ "${last_n_linked_sessions}" -lt "${REQUIRED_SESSIONS}" ]; then
  pass=0
  fail_reasons+=("last ${REQUIRED_SESSIONS} provider sessions are not all event+ledger linked")
fi
if [ "${incomplete_session_links}" -ne 0 ]; then
  pass=0
  fail_reasons+=("scoped provider session links without linked provider events found")
fi
if [ "${last_n_completed_proof_sessions}" -lt "${REQUIRED_SESSIONS}" ]; then
  pass=0
  fail_reasons+=("last ${REQUIRED_SESSIONS} linked provider sessions do not all have matching completed WorkItem proof receipts")
fi
if [ "${last_n_completed_proof_work_items}" -lt "${REQUIRED_SESSIONS}" ]; then
  pass=0
  fail_reasons+=("last ${REQUIRED_SESSIONS} linked provider sessions do not have distinct completed WorkItem proofs")
fi
if [ "${multi_session_proof_work_items}" -ne 0 ]; then
  pass=0
  fail_reasons+=("completed WorkItem proofs are reused across multiple provider sessions")
fi
if [ "${last_n_surface_bound_proof_sessions}" -lt "${REQUIRED_SESSIONS}" ]; then
  pass=0
  fail_reasons+=("last ${REQUIRED_SESSIONS} linked provider sessions do not all have surface-bound WorkItem proofs")
fi
if [ "${surface_unbound_proof_session_runs}" -ne 0 ]; then
  pass=0
  fail_reasons+=("ledger-linked Codex/Claude session runs have proof without a bound Mission SurfaceThread")
fi
if [ "${unlinked_events}" -ne 0 ]; then
  pass=0
  fail_reasons+=("Codex/Claude provider events without token_ledger_ref found")
fi
if [ "${ledger_rows}" -lt "${REQUIRED_SESSIONS}" ]; then
  pass=0
  fail_reasons+=("Codex/Claude token_ledger rows below required sessions")
fi
if [ "${completed_work_items}" -lt "${REQUIRED_SESSIONS}" ]; then
  pass=0
  fail_reasons+=("completed Codex/Claude work_items below required sessions")
fi
if [ "${claimed_process_observations}" -lt 1 ]; then
  pass=0
  fail_reasons+=("no claimed Codex/Claude process observation")
fi
if [ "${last_n_process_proved_sessions}" -lt "${REQUIRED_SESSIONS}" ]; then
  pass=0
  fail_reasons+=("last ${REQUIRED_SESSIONS} provider sessions do not all have timely provider process observations")
fi
if [ "${last_n_claim_bound_process_proved_sessions}" -lt "${REQUIRED_SESSIONS}" ]; then
  pass=0
  fail_reasons+=("last ${REQUIRED_SESSIONS} provider sessions do not all have claim-bound provider process observations")
fi
if [ "${codex_session_links}" -gt 0 ] && [ "${claimed_codex_process_observations}" -lt 1 ]; then
  pass=0
  fail_reasons+=("qualified Codex sessions found without claimed Codex process observation")
fi
if [ "${claude_session_links}" -gt 0 ] && [ "${claimed_claude_process_observations}" -lt 1 ]; then
  pass=0
  fail_reasons+=("qualified Claude sessions found without claimed Claude process observation")
fi
if [ "${orphan_ledger_refs}" -ne 0 ]; then
  pass=0
  fail_reasons+=("provider events have token_ledger_ref values without matching token_ledger rows")
fi
if [ "${invalid_ledger_refs}" -ne 0 ]; then
  pass=0
  fail_reasons+=("provider events have token_ledger_ref values with mismatched/weak token_ledger rows")
fi
if [ "${duplicate_session_run_ids}" -ne 0 ]; then
  pass=0
  fail_reasons+=("token_ledger run_id values are shared by multiple provider sessions")
fi
if [ "${unreferenced_ledger_rows}" -ne 0 ]; then
  pass=0
  fail_reasons+=("Codex/Claude token_ledger rows without matching provider_session_event refs")
fi
if [ "${unproved_linked_session_runs}" -ne 0 ]; then
  pass=0
  fail_reasons+=("ledger-linked Codex/Claude session runs without matching completed WorkItem proof found")
fi
if [ "${wedge_like_logs}" -ne 0 ]; then
  pass=0
  fail_reasons+=("wedge/panic-like log lines found in recent logs")
fi

echo "Friday observe-wrapper D8 audit"
echo "--------------------------------"
echo "DB: ${RUST_HUB_DB}"
echo "TS hub: ${TS_HUB}"
echo "since_ms: ${SINCE_MS}"
echo "required_sessions: ${REQUIRED_SESSIONS}"
echo "scoped: ${scoped}"
echo
echo "Service:"
echo "  ts_health_ok=${health_ok}"
echo "  rust_agent_run_ws=${RUST_WS_HOST}:${RUST_WS_PORT}"
echo "  rust_agent_run_ws_port_ok=${rust_ws_port_ok}"
echo
echo "Session/event evidence:"
echo "  provider_session_links=${session_links}"
echo "  codex_session_links=${codex_session_links}"
echo "  claude_session_links=${claude_session_links}"
echo "  unqualified_session_links=${unqualified_session_links}"
echo "  event_sessions=${event_sessions}"
echo "  linked_event_sessions=${linked_event_sessions}"
echo "  events_total=${events_total}"
echo "  linked_events=${linked_events}"
echo "  unlinked_events=${unlinked_events}"
echo "  last_${REQUIRED_SESSIONS}_linked_sessions=${last_n_linked_sessions}"
echo "  incomplete_session_links=${incomplete_session_links}"
echo "  last_${REQUIRED_SESSIONS}_completed_proof_sessions=${last_n_completed_proof_sessions}"
echo "  last_${REQUIRED_SESSIONS}_completed_proof_work_items=${last_n_completed_proof_work_items}"
echo "  multi_session_proof_work_items=${multi_session_proof_work_items}"
echo "  last_${REQUIRED_SESSIONS}_surface_bound_proof_sessions=${last_n_surface_bound_proof_sessions}"
echo "  surface_unbound_proof_session_runs=${surface_unbound_proof_session_runs}"
echo
echo "Ledger evidence:"
echo "  ledger_rows_codex_or_claude=${ledger_rows}"
echo "  codex_ledger_rows=${codex_ledger_rows}"
echo "  claude_or_anthropic_ledger_rows=${claude_ledger_rows}"
echo "  orphan_token_ledger_refs=${orphan_ledger_refs}"
echo "  invalid_token_ledger_refs=${invalid_ledger_refs}"
echo "  duplicate_session_run_ids=${duplicate_session_run_ids}"
echo "  unreferenced_ledger_rows=${unreferenced_ledger_rows}"
echo "  unproved_linked_session_runs=${unproved_linked_session_runs}"
echo
echo "Work/process evidence:"
echo "  work_items_codex_or_claude=${work_items_total}"
echo "  completed_work_items=${completed_work_items}"
echo "  claimed_process_observations=${claimed_process_observations}"
echo "  claimed_codex_process_observations=${claimed_codex_process_observations}"
echo "  claimed_claude_process_observations=${claimed_claude_process_observations}"
echo "  last_${REQUIRED_SESSIONS}_process_proved_sessions=${last_n_process_proved_sessions}"
echo "  last_${REQUIRED_SESSIONS}_claim_bound_process_proved_sessions=${last_n_claim_bound_process_proved_sessions}"
echo
echo "Log evidence:"
echo "  wedge_like_recent_log_lines=${wedge_like_logs}"
echo

if [ "${pass}" -eq 1 ]; then
  echo "PASS - D8 evidence is present for the configured scoped window."
  echo "Truth: this proves the audit inputs meet the D8 evidence bar; it does not create traffic."
  exit 0
fi

echo "FAIL - D8 evidence is incomplete."
echo "Missing/weak evidence:"
for reason in "${fail_reasons[@]}"; do
  echo "  - ${reason}"
done
if [ "${DETAIL_LIMIT}" -gt 0 ]; then
  echo
  echo "Recent scoped session details (diagnostic only; PASS criteria unchanged):"
  sql_scalar "
    WITH sessions AS (
      SELECT
        l.friday_session_id AS friday_session_id,
        l.provider AS provider,
        COALESCE(MAX(e.observed_at), l.last_provider_seen_at, 0) AS seen_at,
        COUNT(e.provider_event_id) AS event_count,
        SUM(
          CASE
            WHEN COALESCE(e.token_ledger_ref,'') <> ''
             AND ledger.ledger_id IS NOT NULL
             AND ledger.fallback = 0
             AND ledger.total_tokens > 0
             AND (
               (l.provider = 'codex' AND ledger.provider_kind = 'codex')
               OR (l.provider = 'claude' AND ledger.provider_kind IN ('claude','anthropic'))
             )
            THEN 1 ELSE 0
          END
        ) AS linked_event_count
      FROM provider_session_link l
      LEFT JOIN provider_session_event e
        ON e.friday_session_id = l.friday_session_id
       AND e.provider = l.provider
       AND e.observed_at >= ${SINCE_MS}
      LEFT JOIN token_ledger ledger
        ON ledger.ledger_id = e.token_ledger_ref
      WHERE (
          (l.provider = 'codex' AND l.sync_mode = 'provider_app_server_local')
          OR (l.provider = 'claude' AND l.sync_mode = 'friday_local_mirror')
        )
        AND COALESCE(l.last_provider_seen_at,0) >= ${SINCE_MS}
      GROUP BY l.friday_session_id, l.provider
    ),
    recent AS (
      SELECT *
      FROM sessions
      ORDER BY seen_at DESC, friday_session_id DESC
      LIMIT ${DETAIL_LIMIT}
    )
    SELECT
      '  - provider=' || r.provider
      || ' session=' || r.friday_session_id
      || ' seen_at=' || r.seen_at
      || ' events=' || r.event_count
      || ' linked_events=' || COALESCE(r.linked_event_count,0)
      || ' runs=' || COALESCE((
        SELECT group_concat(DISTINCT ledger.run_id)
        FROM provider_session_event e
        JOIN token_ledger ledger
          ON ledger.ledger_id = e.token_ledger_ref
        WHERE e.friday_session_id = r.friday_session_id
          AND e.provider = r.provider
          AND e.observed_at >= ${SINCE_MS}
          AND COALESCE(ledger.run_id,'') <> ''
          AND ledger.fallback = 0
          AND ledger.total_tokens > 0
      ), '')
      || ' completed_proof_runs=' || (
        SELECT COUNT(DISTINCT ledger.run_id)
        FROM provider_session_event e
        JOIN token_ledger ledger
          ON ledger.ledger_id = e.token_ledger_ref
        JOIN work_item w
          ON (w.lane = r.provider OR w.target_provider_or_agent = r.provider)
         AND w.status = 'completed_with_proof'
         AND w.updated_at_ms >= ${SINCE_MS}
         AND w.updated_at_ms >= ledger.created_at
        JOIN json_each(w.proof_receipts) proof
          ON proof.value = 'friday://agent-run/' || ledger.run_id
        WHERE e.friday_session_id = r.friday_session_id
          AND e.provider = r.provider
          AND e.observed_at >= ${SINCE_MS}
          AND COALESCE(ledger.run_id,'') <> ''
          AND ledger.fallback = 0
          AND ledger.total_tokens > 0
      )
      || ' surface_bound_runs=' || (
        SELECT COUNT(DISTINCT ledger.run_id)
        FROM provider_session_event e
        JOIN token_ledger ledger
          ON ledger.ledger_id = e.token_ledger_ref
        JOIN work_item w
          ON (w.lane = r.provider OR w.target_provider_or_agent = r.provider)
         AND w.status = 'completed_with_proof'
         AND w.updated_at_ms >= ${SINCE_MS}
         AND w.updated_at_ms >= ledger.created_at
        JOIN json_each(w.proof_receipts) proof
          ON proof.value = 'friday://agent-run/' || ledger.run_id
        JOIN mission m
          ON m.mission_id = w.mission_id
         AND m.created_at_ms >= ${SINCE_MS}
         AND m.created_at_ms <= w.updated_at_ms
        JOIN surface_thread surface
          ON surface.mission_id = w.mission_id
         AND surface.friday_conversation_id = m.friday_conversation_id
         AND surface.created_at_ms >= ${SINCE_MS}
         AND surface.created_at_ms <= w.updated_at_ms
         AND surface.surface_kind = 'mobile'
         AND COALESCE(surface.delivery_route,'') <> ''
        WHERE e.friday_session_id = r.friday_session_id
          AND e.provider = r.provider
          AND e.observed_at >= ${SINCE_MS}
          AND COALESCE(ledger.run_id,'') <> ''
          AND ledger.fallback = 0
          AND ledger.total_tokens > 0
      )
      || ' claim_bound_process=' || (
        SELECT COUNT(*)
        FROM process_observation observation
        WHERE observation.ownership_status = 'friday_owned_claimed'
          AND observation.observed_at_ms >= ${SINCE_MS}
          AND observation.observed_at_ms <= r.seen_at
          AND (
            (
              r.provider = 'codex'
              AND observation.process_kind = 'codex_app_server'
              AND observation.port_bindings LIKE '%\"friday://provider-session/' || r.friday_session_id || '\"%'
            )
            OR (r.provider = 'claude' AND observation.process_kind = 'claude')
          )
      )
    FROM recent r;
  "
  echo
fi
echo "Truth: built/ready/proof scripts are not the same as D8. Run scoped real traffic, then re-run this audit with FRIDAY_D8_AUDIT_SINCE_MS set."
exit 1
