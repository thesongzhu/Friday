#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'EOF'
usage:
  scripts/ops/friday-ios-live-write-read-capture.sh --out-dir /abs/capture-dir
    [--read-host 127.0.0.1] [--read-port 48751]
    [--write-host 127.0.0.1] [--write-port 48750]
    [--mission-id codex-organic-mission-...]
    [--shared-id mission_ui_device_...]

Runs the env-gated iOS live write->read projection proof, converts the redacted
artifact into mobile same-run proof events, and writes a capture index.

Truth: this writes a real mobile live write-read proof only when the Swift live
test succeeds. It does not claim desktop/channel/timeline proof, END-BAR,
GO-LIVE, adoption, or operator signing completion.
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
mission_id="${FRIDAY_MISSION_SPINE_UI_PROOF_MISSION_ID:-}"

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
    --shared-id)
      [ "$#" -ge 2 ] || die "--shared-id requires a value"
      shared_id="$2"
      shift 2
      ;;
    --shared-id=*)
      shared_id="${1#--shared-id=}"
      shift
      ;;
    --mission-id)
      [ "$#" -ge 2 ] || die "--mission-id requires a value"
      mission_id="$2"
      shift 2
      ;;
    --mission-id=*)
      mission_id="${1#--mission-id=}"
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
case "${shared_id}" in (*[[:space:]]*) die "--shared-id must not contain whitespace" ;; esac
case "${mission_id}" in (*[[:space:]]*) die "--mission-id must not contain whitespace" ;; esac
if [ -n "${shared_id}" ] && [ -n "${mission_id}" ]; then
  die "--mission-id and --shared-id are mutually exclusive"
fi
if [ -n "${mission_id}" ]; then
  case "${mission_id}" in (*mission*) ;; *) die "--mission-id must contain mission" ;; esac
fi

mkdir -p "${out_dir}"
proof_path="${out_dir}/ios-live-write-read-proof.json"
events_path="${out_dir}/ios-live-write-read-events.jsonl"
action_runtime_path="${out_dir}/action-runtime-evidence.json"
index_path="${out_dir}/capture-index.json"

echo "Friday iOS live write-read capture starting."
echo "out_dir=${out_dir}"
echo "read=${read_host}:${read_port}"
echo "write=${write_host}:${write_port}"
echo "truth=ios_live_write_read_capture_runner_not_ui_device_proof"

(
  cd "${repo_root}"
  FRIDAY_MOBILE_LIVE_WRITE_READ_ROUNDTRIP_TEST=1 \
  FRIDAY_MOBILE_LIVE_WRITE_READ_ROUNDTRIP_PROOF_OUT="${proof_path}" \
  FRIDAY_MOBILE_LIVE_READ_HOST="${read_host}" \
  FRIDAY_MOBILE_LIVE_READ_PORT="${read_port}" \
  FRIDAY_MOBILE_LIVE_WRITE_HOST="${write_host}" \
  FRIDAY_MOBILE_LIVE_WRITE_PORT="${write_port}" \
  FRIDAY_MISSION_SPINE_UI_PROOF_SHARED_ID="${shared_id}" \
  FRIDAY_MISSION_SPINE_UI_PROOF_MISSION_ID="${mission_id}" \
    swift test --package-path apps/friday-ios --filter LiveWriteReadProjectionRoundTrip
)

[ -s "${proof_path}" ] || die "Swift live write-read proof did not create ${proof_path}"

node "${repo_root}/scripts/ops/friday-ios-live-write-read-proof-events.mjs" \
  --proof="${proof_path}" \
  --out="${events_path}" \
  --action-runtime-out="${action_runtime_path}" \
  --require-ready >/tmp/friday-ios-live-write-read-proof-events.$$.json

[ -s "${events_path}" ] || die "proof-events driver did not create ${events_path}"
[ -s "${action_runtime_path}" ] || die "proof-events driver did not create ${action_runtime_path}"

node - "${proof_path}" "${events_path}" "${action_runtime_path}" "${index_path}" <<'NODE'
const { readFileSync, writeFileSync } = require("node:fs");
const { createHash } = require("node:crypto");

const [proofPath, eventsPath, actionRuntimePath, indexPath] = process.argv.slice(2);
const proof = JSON.parse(readFileSync(proofPath, "utf8"));
const events = readFileSync(eventsPath, "utf8")
  .trim()
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line));
const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

const index = {
  truth_label: "ios_live_write_read_capture_index_not_ui_device_proof",
  status: "ready",
  generated_at_utc: new Date().toISOString(),
  mission_id: proof.mission_id,
  work_item_id: proof.work_item_id,
  mobile: {
    proof: proofPath,
    proof_sha256: sha256(proofPath),
    events: eventsPath,
    events_sha256: sha256(eventsPath),
    action_runtime_evidence: actionRuntimePath,
    action_runtime_evidence_sha256: sha256(actionRuntimePath),
    event_count: events.length,
  },
  blockers: [],
  caveat: "Mobile same-run capture only; still requires desktop/channel/timeline evidence before strict UI/device proof.",
};

writeFileSync(indexPath, `${JSON.stringify(index, null, 2)}\n`);
NODE

echo "PASS - mobile live write-read proof, same-run events, and capture index written."
echo "proof=${proof_path}"
echo "events=${events_path}"
echo "index=${index_path}"
echo "Truth: mobile-only proof input; not END-BAR / not GO-LIVE / not adoption."
