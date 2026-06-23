#!/usr/bin/env bash
#
# Start a short-lived Friday QR pairing session.
#
# Truth boundary:
#   This launches the DARK hub_pairing_server explicitly. It can write trusted_device rows and
#   append the paired device to the read-seam allowlist only after a valid PairAck. It does not mint
#   trust_grant/context_passport rows, does not read operator signing keys, and does not flip flags.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

DB_PATH="${FRIDAY_PAIRING_DB_PATH:-${HOME}/Library/Application Support/Friday/state/rust-hub.sqlite}"
HOST="${FRIDAY_PAIRING_HOST:-127.0.0.1}"
PORT="${FRIDAY_PAIRING_PORT:-0}"
OWNER="${FRIDAY_PAIRING_OWNER:-jarvis}"
HUB_ID="${FRIDAY_PAIRING_HUB_ID:-friday-hub-$(hostname -s 2>/dev/null || echo local)}"
PAIRING_ID="${FRIDAY_PAIRING_ID:-pair-$(date -u +%Y%m%dT%H%M%SZ)-$RANDOM}"
DISPLAY_NAME="${FRIDAY_PAIRING_DISPLAY_NAME:-Friday Hub on $(hostname -s 2>/dev/null || echo this-mac)}"
TTL_SECONDS="${FRIDAY_PAIRING_TTL_SECONDS:-600}"
OUT_DIR="${FRIDAY_PAIRING_OUT_DIR:-${TMPDIR:-/tmp}/friday-pairing}"
QR_JSON_OUT="${FRIDAY_PAIRING_QR_JSON_OUT:-${OUT_DIR}/${PAIRING_ID}.json}"
ONCE="${FRIDAY_PAIRING_ONCE:-0}"
ALLOW_NON_LOOPBACK="${FRIDAY_PAIRING_ALLOW_NON_LOOPBACK:-0}"

case "${TTL_SECONDS}" in
  ''|*[!0-9]*)
    echo "FATAL: FRIDAY_PAIRING_TTL_SECONDS must be a positive integer." >&2
    exit 3
    ;;
esac
if [ "${TTL_SECONDS}" -le 0 ]; then
  echo "FATAL: FRIDAY_PAIRING_TTL_SECONDS must be positive." >&2
  exit 3
fi
case "${PORT}" in
  ''|*[!0-9]*)
    echo "FATAL: FRIDAY_PAIRING_PORT must be a u16 integer." >&2
    exit 3
    ;;
esac
if [ "${PORT}" -gt 65535 ]; then
  echo "FATAL: FRIDAY_PAIRING_PORT must be <= 65535." >&2
  exit 3
fi

mkdir -p "${OUT_DIR}"
chmod 700 "${OUT_DIR}" 2>/dev/null || true

is_private_ipv4() {
  case "$1" in
    10.*|192.168.*|169.254.*) return 0 ;;
    172.1[6-9].*|172.2[0-9].*|172.3[0-1].*) return 0 ;;
    *) return 1 ;;
  esac
}

if [ "${HOST}" = "auto-lan" ]; then
  HOST=""
  for iface in en0 en1 bridge100; do
    candidate="$(ipconfig getifaddr "${iface}" 2>/dev/null || true)"
    if [ -n "${candidate}" ] && is_private_ipv4 "${candidate}"; then
      HOST="${candidate}"
      break
    fi
  done
  if [ -z "${HOST}" ]; then
    echo "FATAL: could not discover a private LAN IPv4 for FRIDAY_PAIRING_HOST=auto-lan." >&2
    exit 3
  fi
  ALLOW_NON_LOOPBACK="1"
fi

PAIRING_SECRET="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(24).toString("hex"))')"
EXPIRES_AT_MS="$(node -e "process.stdout.write(String(Date.now() + Number(${TTL_SECONDS}) * 1000))")"

ARGS=(
  run -p friday-hub --bin hub_pairing_server --
  --db "${DB_PATH}"
  --pairing-secret "${PAIRING_SECRET}"
  --hub-id "${HUB_ID}"
  --pairing-id "${PAIRING_ID}"
  --display-name "${DISPLAY_NAME}"
  --expires-at-ms "${EXPIRES_AT_MS}"
  --owner "${OWNER}"
  --host "${HOST}"
  --port "${PORT}"
  --qr-json-out "${QR_JSON_OUT}"
)

if [ "${ALLOW_NON_LOOPBACK}" = "1" ]; then
  ARGS+=(--allow-non-loopback)
fi
if [ "${ONCE}" = "1" ]; then
  ARGS+=(--once)
fi

cat >&2 <<EOF
Friday pairing session starting.
DB: ${DB_PATH}
Host: ${HOST}
Port: ${PORT}
QR manifest: ${QR_JSON_OUT}
TTL seconds: ${TTL_SECONDS}
Truth: explicit DARK pairing server; no trust_grant/context_passport mint, no operator signing key.
EOF

cd "${REPO_ROOT}"
exec cargo "${ARGS[@]}"
