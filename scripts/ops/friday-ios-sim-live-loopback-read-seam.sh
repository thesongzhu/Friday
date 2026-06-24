#!/usr/bin/env bash
#
# One-command iOS simulator live-loopback proof + read-seam peer reconciliation.
#
# Truth boundary:
#   Default mode builds/runs the simulator app in explicit live-loopback mode, validates the
#   generated metadata, and dry-runs hub_read_seam_enroll. It writes no SecureStore state.
#   --enroll-read-seam performs the same proof and then enrolls the simulator public read peer,
#   gated by FRIDAY_IOS_SIM_READ_SEAM_ENROLL_ACK. It still does not restart services, grant
#   write access, mint trust_grant/context_passport, sign, or claim END-BAR/GO-LIVE.
#   The read-projection server loads the allowlist at boot; an already-running :48751 process may
#   need a separate safe reload before newly-enrolled peers are admitted.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

SHOT="${FRIDAY_IOS_SIM_LIVE_LOOPBACK_SHOT:-${REPO_ROOT}/apps/friday-ios/.build-sim/friday-ios-live-loopback-read-seam.png}"
METADATA=""
ENROLL=0
SKIP_BUILD=0

usage() {
  cat <<'EOF'
usage:
  scripts/ops/friday-ios-sim-live-loopback-read-seam.sh [--shot <png>] [--metadata <shot.metadata.json>] [--enroll-read-seam]

truth:
  Without --enroll-read-seam this is a dry-run proof and writes no SecureStore state.
  --metadata skips the simulator build and validates an existing live-loopback metadata file.
  The read-projection server loads the allowlist at boot; this wrapper never restarts it.
  --enroll-read-seam requires:
    FRIDAY_IOS_SIM_READ_SEAM_ENROLL_ACK=operator-approves-ios-sim-read-seam-enroll
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --shot)
      shift
      if [ "$#" -eq 0 ]; then
        echo "FATAL: --shot requires a value." >&2
        exit 3
      fi
      SHOT="$1"
      ;;
    --metadata)
      shift
      if [ "$#" -eq 0 ]; then
        echo "FATAL: --metadata requires a value." >&2
        exit 3
      fi
      METADATA="$1"
      SKIP_BUILD=1
      ;;
    --enroll-read-seam)
      ENROLL=1
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

if [ "${SKIP_BUILD}" = "0" ]; then
  bash "${REPO_ROOT}/apps/friday-ios/build-sim.sh" --mode live-loopback --shot "${SHOT}"
  METADATA="${SHOT}.metadata.json"
fi

if [ -z "${METADATA}" ]; then
  echo "FATAL: metadata path was not resolved." >&2
  exit 3
fi

args=(--metadata "${METADATA}")
if [ "${ENROLL}" = "1" ]; then
  args+=(--enroll)
fi

node "${SCRIPT_DIR}/friday-ios-sim-read-seam-enroll.mjs" "${args[@]}"
