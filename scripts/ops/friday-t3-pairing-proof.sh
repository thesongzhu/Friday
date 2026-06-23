#!/usr/bin/env bash
#
# Run a real T3 QR-pairing proof against the DARK hub_pairing_server.
#
# Truth boundary:
#   --status-only opens the sealed pairing channel and writes no trusted device.
#   --pair sends a real Pair request and can write device_identity + trusted_device rows after
#   PairAck. It never reads operator signing keys and never mints trust_grant/context_passport.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

MODE=""
DEVICE_ID="${FRIDAY_T3_PAIRING_DEVICE_ID:-friday-t3-pairing-proof-$(date -u +%Y%m%dT%H%M%SZ)}"
TIMEOUT_SECONDS="${FRIDAY_T3_PAIRING_PROOF_TIMEOUT_SECONDS:-45}"

usage() {
  cat <<'EOF'
usage:
  scripts/ops/friday-t3-pairing-proof.sh --status-only
  FRIDAY_T3_PAIRING_PROOF_ACK=operator-runs-t3-pairing-proof \
    scripts/ops/friday-t3-pairing-proof.sh --pair [--device-id <id>]

truth:
  Starts the explicit DARK hub_pairing_server, runs the Swift FridayPairingProof client, and
  reconciles the observed DB delta. It does not read operator signing keys, does not mint
  trust_grant/context_passport, and does not flip any live flags.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --status-only)
      MODE="status-only"
      ;;
    --pair)
      MODE="pair"
      ;;
    --device-id)
      shift
      if [ "$#" -eq 0 ]; then
        echo "FATAL: --device-id requires a value." >&2
        exit 3
      fi
      DEVICE_ID="$1"
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "FATAL: unknown argument: $1" >&2
      usage >&2
      exit 3
      ;;
  esac
  shift
done

if [ -z "${MODE}" ]; then
  echo "FATAL: choose --status-only or --pair." >&2
  usage >&2
  exit 3
fi
case "${TIMEOUT_SECONDS}" in
  ''|*[!0-9]*)
    echo "FATAL: FRIDAY_T3_PAIRING_PROOF_TIMEOUT_SECONDS must be a positive integer." >&2
    exit 3
    ;;
esac
if [ "${TIMEOUT_SECONDS}" -le 0 ]; then
  echo "FATAL: FRIDAY_T3_PAIRING_PROOF_TIMEOUT_SECONDS must be positive." >&2
  exit 3
fi
if [ "${MODE}" = "pair" ] && [ "${FRIDAY_T3_PAIRING_PROOF_ACK:-}" != "operator-runs-t3-pairing-proof" ]; then
  echo "FATAL: --pair writes trusted-device state; set FRIDAY_T3_PAIRING_PROOF_ACK=operator-runs-t3-pairing-proof." >&2
  exit 4
fi

DB_PATH="${FRIDAY_PAIRING_DB_PATH:-${HOME}/Library/Application Support/Friday/state/rust-hub.sqlite}"
OUT_DIR="${FRIDAY_T3_PAIRING_PROOF_OUT_DIR:-${TMPDIR:-/tmp}/friday-t3-pairing-proof-$(date -u +%Y%m%dT%H%M%SZ)-$$}"
PAIRING_ID="${FRIDAY_PAIRING_ID:-t3-pair-proof-$(date -u +%Y%m%dT%H%M%SZ)-$$}"
QR_JSON_OUT="${OUT_DIR}/${PAIRING_ID}.json"
SERVER_LOG="${OUT_DIR}/hub-pairing-server.log"
CLIENT_OUT="${OUT_DIR}/friday-pairing-proof.json"
STATUS_QUERY_OUT="${OUT_DIR}/db-reconcile.txt"

mkdir -p "${OUT_DIR}"
chmod 700 "${OUT_DIR}" 2>/dev/null || true

server_pid=""
cleanup() {
  if [ -n "${server_pid}" ] && kill -0 "${server_pid}" 2>/dev/null; then
    kill "${server_pid}" 2>/dev/null || true
    wait "${server_pid}" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

sqlite_count() {
  local sql="$1"
  if ! command -v sqlite3 >/dev/null 2>&1; then
    echo "sqlite3_unavailable"
    return 0
  fi
  sqlite3 -readonly "${DB_PATH}" "${sql}" 2>/dev/null || echo "query_unavailable"
}

before_device_count="$(sqlite_count "SELECT count(*) FROM trusted_device WHERE device_id = '${DEVICE_ID//\'/\'\'}';")"
before_grants="$(sqlite_count "SELECT count(*) FROM trust_grant;")"
before_passports="$(sqlite_count "SELECT count(*) FROM context_passport;")"

FRIDAY_PAIRING_ID="${PAIRING_ID}" \
FRIDAY_PAIRING_QR_JSON_OUT="${QR_JSON_OUT}" \
FRIDAY_PAIRING_OUT_DIR="${OUT_DIR}" \
FRIDAY_PAIRING_ONCE=1 \
"${SCRIPT_DIR}/friday-start-pairing-session.sh" >"${SERVER_LOG}" 2>&1 &
server_pid="$!"

deadline=$((SECONDS + TIMEOUT_SECONDS))
while [ ! -s "${QR_JSON_OUT}" ]; do
  if ! kill -0 "${server_pid}" 2>/dev/null; then
    echo "FATAL: pairing server exited before writing QR manifest. Log: ${SERVER_LOG}" >&2
    sed -n '1,120p' "${SERVER_LOG}" >&2 || true
    exit 5
  fi
  if [ "${SECONDS}" -ge "${deadline}" ]; then
    echo "FATAL: timed out waiting for QR manifest. Log: ${SERVER_LOG}" >&2
    exit 5
  fi
  sleep 0.25
done

proof_args=(run --package-path "${REPO_ROOT}/apps/macos/FridayHubConsole" FridayPairingProof --manifest "${QR_JSON_OUT}")
if [ "${MODE}" = "status-only" ]; then
  proof_args+=(--status-only)
else
  proof_args+=(--pair --device-id "${DEVICE_ID}")
fi

swift "${proof_args[@]}" | tee "${CLIENT_OUT}"

after_device_count="$(sqlite_count "SELECT count(*) FROM trusted_device WHERE device_id = '${DEVICE_ID//\'/\'\'}';")"
after_grants="$(sqlite_count "SELECT count(*) FROM trust_grant;")"
after_passports="$(sqlite_count "SELECT count(*) FROM context_passport;")"

{
  echo "truth=friday_t3_pairing_proof_no_operator_key_no_grant_no_passport"
  echo "mode=${MODE}"
  echo "device_id=${DEVICE_ID}"
  echo "pairing_id=${PAIRING_ID}"
  echo "db=${DB_PATH}"
  echo "trusted_device_count_before=${before_device_count}"
  echo "trusted_device_count_after=${after_device_count}"
  echo "trust_grant_count_before=${before_grants}"
  echo "trust_grant_count_after=${after_grants}"
  echo "context_passport_count_before=${before_passports}"
  echo "context_passport_count_after=${after_passports}"
  echo "client_output=${CLIENT_OUT}"
  echo "server_log=${SERVER_LOG}"
} | tee "${STATUS_QUERY_OUT}"

if [ "${MODE}" = "pair" ] && [ "${after_device_count}" = "0" ]; then
  echo "FATAL: PairAck proof completed but trusted_device was not observed for ${DEVICE_ID}." >&2
  exit 6
fi
if [ "${before_grants}" != "sqlite3_unavailable" ] && [ "${after_grants}" != "${before_grants}" ]; then
  echo "FATAL: trust_grant count changed during pairing proof; this wrapper must not mint grants." >&2
  exit 7
fi
if [ "${before_passports}" != "sqlite3_unavailable" ] && [ "${after_passports}" != "${before_passports}" ]; then
  echo "FATAL: context_passport count changed during pairing proof; this wrapper must not mint passports." >&2
  exit 7
fi
