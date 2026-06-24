#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'EOF'
usage:
  scripts/ops/friday-ui-device-live-write-read-capture-bundle.sh --out-dir /abs/capture-root
    [--shared-id mission_ui_device_...]
    [--read-host 127.0.0.1] [--read-port 48751]
    [--write-host 127.0.0.1] [--write-port 48750]

Runs the mobile and desktop live write-read capture runners with one shared
mission id, then indexes the resulting artifacts into a partial bundle.

Truth: this orchestrates real capture runners only. It does not synthesize
proof rows, does not create channel/timeline/stress observations, and does not
claim END-BAR, GO-LIVE, adoption, or operator signing completion.
EOF
}

die() {
  echo "FATAL: $*" >&2
  exit 2
}

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
out_dir=""
read_host="${FRIDAY_MOBILE_LIVE_READ_HOST:-127.0.0.1}"
read_port="${FRIDAY_MOBILE_LIVE_READ_PORT:-48751}"
write_host="${FRIDAY_MOBILE_LIVE_WRITE_HOST:-127.0.0.1}"
write_port="${FRIDAY_MOBILE_LIVE_WRITE_PORT:-48750}"
shared_id="${FRIDAY_MISSION_SPINE_UI_PROOF_SHARED_ID:-}"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --out-dir)
      [ "$#" -ge 2 ] || die "--out-dir requires a value"
      out_dir="$2"
      shift 2
      ;;
    --out-dir=*)
      out_dir="${1#--out-dir=}"
      shift
      ;;
    --shared-id)
      [ "$#" -ge 2 ] || die "--shared-id requires a value"
      shared_id="$2"
      shift 2
      ;;
    --shared-id=*)
      shared_id="${1#--shared-id=}"
      shift
      ;;
    --read-host)
      [ "$#" -ge 2 ] || die "--read-host requires a value"
      read_host="$2"
      shift 2
      ;;
    --read-host=*)
      read_host="${1#--read-host=}"
      shift
      ;;
    --read-port)
      [ "$#" -ge 2 ] || die "--read-port requires a value"
      read_port="$2"
      shift 2
      ;;
    --read-port=*)
      read_port="${1#--read-port=}"
      shift
      ;;
    --write-host)
      [ "$#" -ge 2 ] || die "--write-host requires a value"
      write_host="$2"
      shift 2
      ;;
    --write-host=*)
      write_host="${1#--write-host=}"
      shift
      ;;
    --write-port)
      [ "$#" -ge 2 ] || die "--write-port requires a value"
      write_port="$2"
      shift 2
      ;;
    --write-port=*)
      write_port="${1#--write-port=}"
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      die "unknown argument: $1"
      ;;
  esac
done

[ -n "${out_dir}" ] || die "missing --out-dir"
case "${out_dir}" in
  /*) ;;
  *) die "--out-dir must be absolute" ;;
esac
case "${read_port}" in (*[!0-9]*|"") die "--read-port must be numeric" ;; esac
case "${write_port}" in (*[!0-9]*|"") die "--write-port must be numeric" ;; esac

if [ -z "${shared_id}" ]; then
  shared_id="mission-ui-device-live-write-read-$(date -u +%Y%m%dT%H%M%SZ)-$(uuidgen | tr '[:upper:]' '[:lower:]')"
fi
case "${shared_id}" in (*[[:space:]]*) die "--shared-id must not contain whitespace" ;; esac
case "${shared_id}" in (*mission*) ;; *) die "--shared-id must contain mission" ;; esac

mobile_dir="${out_dir}/mobile"
desktop_dir="${out_dir}/desktop"
bundle_dir="${out_dir}/bundle"

mkdir -p "${out_dir}"

echo "Friday UI/device live write-read capture bundle starting."
echo "out_dir=${out_dir}"
echo "shared_id=${shared_id}"
echo "truth=ui_device_live_write_read_capture_bundle_orchestrator_not_full_proof"

bash "${repo_root}/scripts/ops/friday-ios-live-write-read-capture.sh" \
  --out-dir "${mobile_dir}" \
  --read-host "${read_host}" \
  --read-port "${read_port}" \
  --write-host "${write_host}" \
  --write-port "${write_port}" \
  --shared-id "${shared_id}"

bash "${repo_root}/scripts/ops/friday-macos-live-write-read-capture.sh" \
  --out-dir "${desktop_dir}" \
  --shared-id "${shared_id}"

node "${repo_root}/scripts/ops/friday-ui-device-live-write-read-bundle.mjs" \
  --out-dir="${bundle_dir}" \
  --mobile-capture-dir="${mobile_dir}" \
  --desktop-capture-dir="${desktop_dir}" \
  --mission-id="${shared_id}" \
  --require-ready

echo "PASS - same-mission mobile+desktop live write-read capture bundle written."
echo "bundle=${bundle_dir}/live-write-read-bundle-index.json"
echo "Truth: partial UI/device live write-read bundle only; not END-BAR / not GO-LIVE / not adoption."
