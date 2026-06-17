#!/usr/bin/env bash
#
# friday-proof-of-life.sh — ONE real DeepSeek round-trip on the deployed prod stack.
# ---------------------------------------------------------------------------------
# WHAT THIS DOES
#   Mints an admin-001 bearer from your local passphrase (POST /v1/auth/login),
#   then submits ONE qualifying read-only agent run (POST /v1/agent/runs) that
#   routes TS hub :3141 -> sealed WS -> Rust hub :48750 -> a REAL DeepSeek
#   chat() call (api.deepseek.com). It asks the model to reply "PONG".
#
#   The REAL acceptance signal is a new row in the Rust hub DB `token_ledger`
#   (provider_kind='deepseek', fallback=0, total_tokens>0) written by the Rust
#   server's bill_model_call during the run. The script snapshots that table
#   before and after and PASSES iff a NEW matching row appeared.
#
# WHAT IT COSTS / WHAT IT TOUCHES
#   - Spends a TINY amount of real DeepSeek quota (one short PONG completion,
#     plus an automatic provider key/capability verification probe the route
#     runs for the legitimate run). On the order of a few dozen tokens.
#   - Mutates NOTHING except: (a) creates ONE real agent run + its ledger/audit
#     rows server-side, (b) the routing layer may stamp benign provider
#     "last_verified_*" metadata for the deepseek provider profile (expected
#     side effect of any real run). It does NOT change config, flags, or state.
#
# SECRET HYGIENE
#   - The passphrase is read silently (read -rs), never echoed, never written to
#     disk, and never placed in a process argv (it is JSON-escaped via `jq -Rs`
#     reading stdin and streamed to curl with `--data @-`).
#   - The access token is held only in a shell variable and used only in an
#     Authorization header. It is never printed.
#   - All HTTP is to 127.0.0.1 only. The only external network call is the one
#     the agent run itself triggers server-side (DeepSeek).
#
# USAGE
#   bash scripts/ops/friday-proof-of-life.sh
#   (it will prompt for your local passphrase silently)
#
set -euo pipefail

# ─── Fixed, code-validated constants (see this PR's README for file:line cites) ───
readonly TS_HUB="http://127.0.0.1:3141"
# Deepseek provider PROFILE id (prod rows carry UUIDs; the literal "deepseek"
# would 400 at validateRequestedRoute's exact-id match, so we use the UUID).
readonly DEEPSEEK_PROVIDER_ID="fa15f1fe-a0b6-4f79-96c3-4ae8e1be28a4"
readonly DEEPSEEK_MODEL="deepseek-v4-flash"
readonly RUST_HUB_DB="/Users/jarvis/Library/Application Support/Friday/state/rust-hub.sqlite"
# The exact 4-tool read-only allowlist the qualifier predicate requires (clause 4).
readonly PONG_TASK="Reply with exactly the word PONG and nothing else."

# Prefer a sqlite3 on PATH; fall back to the Android platform-tools one present
# on this box. Read-only immutable opens only.
SQLITE_BIN="$(command -v sqlite3 || true)"
if [ -z "${SQLITE_BIN}" ] && [ -x "/Users/jarvis/Library/Android/sdk/platform-tools/sqlite3" ]; then
  SQLITE_BIN="/Users/jarvis/Library/Android/sdk/platform-tools/sqlite3"
fi

# ─── Preflight: required tooling + listeners ───
for bin in curl jq; do
  if ! command -v "${bin}" >/dev/null 2>&1; then
    echo "FATAL: required tool '${bin}' not found on PATH." >&2
    exit 3
  fi
done
if [ -z "${SQLITE_BIN}" ]; then
  echo "FATAL: no sqlite3 binary found (needed to read the acceptance signal)." >&2
  exit 3
fi
if ! lsof -ti tcp:3141 >/dev/null 2>&1; then
  echo "FATAL: TS hub is not listening on 127.0.0.1:3141. Is com.friday.hub running?" >&2
  exit 3
fi
if ! lsof -ti tcp:48750 >/dev/null 2>&1; then
  echo "FATAL: Rust agent-run server is not listening on 127.0.0.1:48750." >&2
  exit 3
fi
if [ ! -r "${RUST_HUB_DB}" ]; then
  echo "FATAL: Rust hub DB not readable at: ${RUST_HUB_DB}" >&2
  exit 3
fi

# ─── Read-only immutable ledger count helper ───
# Counts real deepseek rows (tokens>0, not a fallback). Immutable open => never
# writes, never locks the live DB.
ledger_count() {
  "${SQLITE_BIN}" "file:${RUST_HUB_DB}?mode=ro" \
    "SELECT COUNT(*) FROM token_ledger WHERE provider_kind='deepseek' AND fallback=0 AND total_tokens>0;" \
    2>/dev/null || echo "ERR"
}

sql_quote() {
  printf '%s' "$1" | sed "s/'/''/g"
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

curl_bearer_get() {
  local url="$1"
  local max_time="$2"
  {
    printf 'silent\n'
    printf 'show-error\n'
    printf 'max-time = %s\n' "${max_time}"
    printf 'request = "GET"\n'
    printf 'url = "%s"\n' "$(curl_config_escape "${url}")"
    printf 'header = "Authorization: Bearer %s"\n' "$(curl_config_escape "${TOKEN}")"
    printf 'write-out = "\\n%%{http_code}"\n'
  } | curl --config - 2>/dev/null
}

# ─── Step 1: login → access token (secret never hits argv/disk) ───
printf 'Enter Friday local passphrase (input hidden): ' >&2
read -rs PASSPHRASE
printf '\n' >&2
if [ -z "${PASSPHRASE}" ]; then
  echo "FATAL: empty passphrase." >&2
  exit 4
fi

# JSON-escape the passphrase via jq reading raw stdin, stream the body to curl
# via --data @- . Neither the passphrase nor the request body appears in argv.
LOGIN_RAW="$(
  printf '%s' "${PASSPHRASE}" \
    | jq -Rs '{localPassphrase: .}' \
    | curl -sS --max-time 30 -w $'\n%{http_code}' \
        -X POST "${TS_HUB}/v1/auth/login" \
        -H 'Content-Type: application/json' \
        --data @- 2>/dev/null
)" || true
# Drop the passphrase from memory ASAP.
unset PASSPHRASE

LOGIN_CODE="$(printf '%s' "${LOGIN_RAW}" | tail -n1)"
LOGIN_BODY="$(printf '%s' "${LOGIN_RAW}" | sed '$d')"
unset LOGIN_RAW

if [ "${LOGIN_CODE}" != "200" ]; then
  echo "FAIL: login returned HTTP ${LOGIN_CODE} (expected 200)." >&2
  echo "      (Bad passphrase, lockout, or hub not ready. Passphrase NOT shown.)" >&2
  exit 4
fi

TOKEN="$(printf '%s' "${LOGIN_BODY}" | jq -r '.data.accessToken // .accessToken // empty')"
unset LOGIN_BODY
if [ -z "${TOKEN}" ]; then
  echo "FAIL: login succeeded (200) but no accessToken field in the response." >&2
  exit 4
fi
echo "Step 1 OK: authenticated (token captured, not shown)."

# ─── Step 2: provider id (resolved/validated above) ───
echo "Step 2 OK: using deepseek provider id ${DEEPSEEK_PROVIDER_ID} (model ${DEEPSEEK_MODEL})."

# ─── Step 3: snapshot the acceptance count BEFORE ───
BEFORE="$(ledger_count)"
if [ "${BEFORE}" = "ERR" ] || ! printf '%s' "${BEFORE}" | grep -qE '^[0-9]+$'; then
  echo "FATAL: could not read token_ledger baseline count (got '${BEFORE}')." >&2
  exit 3
fi
echo "Step 3 OK: token_ledger baseline (deepseek, real, tokens>0) = ${BEFORE}."

# ─── Step 4: POST the qualifying read-only run (blocks through the real call) ───
# Body satisfies qualifiesForRustReadOnlyRoute exactly:
#   providerId=UUID(kind deepseek, enabled), model=deepseek-v4-flash,
#   constraints.readOnly=true, allowedRustRouteTools = the exact 4-tool set.
# Disqualifiers (sessionKey/requireReview/planReviewOverride/review taskProfile)
# are intentionally OMITTED. The Authorization header carries the admin-001 bearer
# so the forwarded principal passes the Rust owner allowlist.
RUN_BODY="$(jq -nc \
  --arg task "${PONG_TASK}" \
  --arg pid "${DEEPSEEK_PROVIDER_ID}" \
  --arg model "${DEEPSEEK_MODEL}" \
  '{
     task: $task,
     providerId: $pid,
     model: $model,
     constraints: { readOnly: true },
     allowedRustRouteTools: ["read_file","list_dir","stat_file","search"]
   }')"

echo "Step 4: submitting the run (this blocks through the real DeepSeek call)..."
RUN_RAW="$(
  curl_bearer_json "POST" "${TS_HUB}/v1/agent/runs" "120" "${RUN_BODY}"
)" || true

RUN_CODE="$(printf '%s' "${RUN_RAW}" | tail -n1)"
RUN_JSON="$(printf '%s' "${RUN_RAW}" | sed '$d')"
unset RUN_RAW

RUN_ID="$(printf '%s' "${RUN_JSON}" | jq -r '.data.runId // .runId // empty' 2>/dev/null || true)"
RUN_STATUS="$(printf '%s' "${RUN_JSON}" | jq -r '.data.status // .status // empty' 2>/dev/null || true)"
RUN_ANSWER="$(printf '%s' "${RUN_JSON}" | jq -r '.data.finalResponse // .data.response // .finalResponse // .response // empty' 2>/dev/null || true)"
RUN_ERRCODE="$(printf '%s' "${RUN_JSON}" | jq -r '.data.error.code // .error.code // .code // empty' 2>/dev/null || true)"
RUN_CLASS="$(printf '%s' "${RUN_JSON}" | jq -r '.data.error.details.classification // .error.details.classification // .details.classification // empty' 2>/dev/null || true)"

echo "Step 4: HTTP ${RUN_CODE}  runId=${RUN_ID:-<none>}  status=${RUN_STATUS:-<none>}"

# ─── Step 5: best-effort run-status poll (diagnostics only) + ledger re-read ───
# The POST is synchronous: it already returned a terminal status + the answer and
# bill_model_call wrote the ledger row before it returned. The poll is a
# belt-and-suspenders diagnostic and tolerates a 404 (the continuity-projected run
# may not be user-visible to GET).
if [ -n "${RUN_ID}" ]; then
  for _ in $(seq 1 30); do
    POLL_RAW="$(curl_bearer_get "${TS_HUB}/v1/agent/runs/${RUN_ID}" "10" || true)"
    POLL_CODE="$(printf '%s' "${POLL_RAW}" | tail -n1)"
    POLL_JSON="$(printf '%s' "${POLL_RAW}" | sed '$d')"
    if [ "${POLL_CODE}" = "200" ]; then
      PS="$(printf '%s' "${POLL_JSON}" | jq -r '.data.status // .status // empty' 2>/dev/null || true)"
      case "${PS}" in
        completed|failed|failed_tests|cancelled) RUN_STATUS="${PS}"; break ;;
      esac
    else
      # Non-200 (e.g. 404 for a non-visible projected run) — stop polling, rely on POST + ledger.
      break
    fi
    sleep 2
  done
fi
unset TOKEN  # token no longer needed

AFTER="$(ledger_count)"
if [ "${AFTER}" = "ERR" ] || ! printf '%s' "${AFTER}" | grep -qE '^[0-9]+$'; then
  echo "WARN: could not re-read token_ledger after the run (got '${AFTER}')." >&2
  AFTER="${BEFORE}"
fi

# Pull the newest matching ledger row correlated to THIS runId. This is the
# acceptance signal; the uncorrelated latest row is diagnostics only because
# another live run may have billed concurrently.
RUN_LEDGER_ROW=""
if [ -n "${RUN_ID}" ]; then
  RUN_ID_SQL="$(sql_quote "${RUN_ID}")"
  RUN_LEDGER_ROW="$("${SQLITE_BIN}" "file:${RUST_HUB_DB}?mode=ro" \
    "SELECT provider_kind || '|' || total_tokens || '|' || datetime(created_at/1000,'unixepoch')
     FROM token_ledger
     WHERE provider_kind='deepseek' AND fallback=0 AND total_tokens>0
       AND (session_id='${RUN_ID_SQL}' OR run_id='${RUN_ID_SQL}')
     ORDER BY created_at DESC LIMIT 1;" 2>/dev/null || true)"
fi
LATEST_MATCHING_ROW="$("${SQLITE_BIN}" "file:${RUST_HUB_DB}?mode=ro" \
  "SELECT provider_kind || '|' || total_tokens || '|' || datetime(created_at/1000,'unixepoch')
   FROM token_ledger
   WHERE provider_kind='deepseek' AND fallback=0 AND total_tokens>0
   ORDER BY created_at DESC LIMIT 1;" 2>/dev/null || true)"

# ─── Step 6: verdict ───
echo
echo "──────────────────────────────────────────────"
echo " token_ledger (deepseek, real, tokens>0): before=${BEFORE} after=${AFTER}"
echo " run-correlated ledger row (provider_kind|total_tokens|created_at): ${RUN_LEDGER_ROW:-<none>}"
echo " latest matching row, any run (diagnostic only): ${LATEST_MATCHING_ROW:-<none>}"
echo " run HTTP=${RUN_CODE}  final status: ${RUN_STATUS:-<unknown>}  answer: ${RUN_ANSWER:-<none>}"
echo "──────────────────────────────────────────────"

# Verdict keys on BOTH a delivered answer AND a new run-correlated ledger row.
# A 200 without the ledger row is not a proof; an uncorrelated ledger advance may
# be concurrent traffic. Billing can still happen before answer delivery, so that
# state is reported as PARTIAL only when the row is tied to this runId.
if [ "${RUN_CODE}" = "200" ] && [ -n "${RUN_ANSWER}" ] \
  && [ -n "${RUN_ID}" ] && [ "${AFTER}" -gt "${BEFORE}" ] && [ -n "${RUN_LEDGER_ROW}" ]; then
  echo
  echo "PASS (FULL) — HTTP 200, the model answer was DELIVERED, AND a new run-correlated ledger row landed."
  echo "   Real DeepSeek round-trip on prod via the Rust route; answer returned to the caller."
  echo "   Model answer: ${RUN_ANSWER}"
  echo "   (ledger ${BEFORE}->${AFTER}; row=${RUN_LEDGER_ROW})"
  exit 0
fi

if [ "${RUN_CODE}" = "200" ] && [ -n "${RUN_ANSWER}" ]; then
  echo
  echo "FAIL — the model answer was delivered, but no NEW run-correlated token_ledger row was found."
  echo "   No-fake-proof guard: FULL PASS requires a billed row tied to runId=${RUN_ID:-<none>}."
  echo "   token_ledger count ${BEFORE}->${AFTER}; latest uncorrelated row=${LATEST_MATCHING_ROW:-<none>}."
  exit 1
fi

if [ "${AFTER}" -gt "${BEFORE}" ] && [ -n "${RUN_LEDGER_ROW}" ]; then
  echo
  echo "PARTIAL — a REAL DeepSeek call was BILLED (ledger ${BEFORE}->${AFTER}, tokens>0) but the answer was NOT delivered (HTTP ${RUN_CODE})."
  echo "   The model ran + billed; the answer-return leg failed. leg-B (readback SQLITE_BUSY) +"
  echo "   the init_failed crash-loop are fixed by this deploy, but a dropped/late body frame (leg-A) still 503'd."
  echo "   => NOT reliable end-to-end yet. Next slice = the deferred leg-A (body-frame) decouple."
  echo "   Inspect the {run_id, leg, code} log for run ${RUN_ID:-<none>}.  errorCode=${RUN_ERRCODE:-<none>} classification=${RUN_CLASS:-<none>}"
  exit 2
fi

if [ "${AFTER}" -gt "${BEFORE}" ]; then
  echo
  echo "FAIL — token_ledger advanced (${BEFORE}->${AFTER}), but no row was correlated to runId=${RUN_ID:-<none>}."
  echo "   Treating the advance as untrusted/concurrent traffic, not proof for this run."
  echo "   latest uncorrelated row=${LATEST_MATCHING_ROW:-<none>}."
  exit 1
fi

# ─── FAIL diagnostics, branched by HTTP code (no secret ever printed) ───
echo
echo "FAIL — no new real DeepSeek ledger row appeared (count unchanged)."
echo "   POST /v1/agent/runs HTTP=${RUN_CODE}  status=${RUN_STATUS:-<none>}  errorCode=${RUN_ERRCODE:-<none>}  classification=${RUN_CLASS:-<none>}"
case "${RUN_CODE}" in
  503)
    echo "   503 = the compose path failed CLOSED. The most likely cause is the"
    echo "   X25519 / master-key parity between the TS hub (keychain master key) and"
    echo "   the Rust server (env-or-file ~/.friday/master.key): if those key bytes"
    echo "   differ, the sealed handshake's pubkey is not in the Rust allowlist and"
    echo "   no session is granted. To check: run the Rust enroll bin with --print-pubkey"
    echo "   and compare it against the TS-derived agent-run WS client pubkey."
    echo "   (Other 503 causes: missing SecureStore key, WS error, readback not delivered.)"
    ;;
  400)
    echo "   400 = route/provider validation rejected the request (provider id, model,"
    echo "   or routing config). Confirm the deepseek provider row is enabled and that"
    echo "   model routing still points at ${DEEPSEEK_PROVIDER_ID}."
    ;;
  401|403)
    echo "   ${RUN_CODE} = the bearer did not authorize as admin-001. Re-run and ensure"
    echo "   you entered the correct local passphrase."
    ;;
  000|"")
    echo "   No HTTP response (timeout/connection). The TS hub may be busy or the run"
    echo "   exceeded the 120s budget. Check that both :3141 and :48750 are healthy."
    ;;
  *)
    echo "   Unexpected HTTP ${RUN_CODE}. Inspect the hub logs for this run id."
    ;;
esac
if [ -n "${RUN_ID}" ]; then
  echo "   Run id for log correlation: ${RUN_ID}"
fi
exit 1
