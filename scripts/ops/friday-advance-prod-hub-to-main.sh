#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
DRY_RUN=0
SIGNED_SHA="${FRIDAY_ADVANCE_SIGNED_SHA:-}"
TS_HUB_HEALTH_URL="${FRIDAY_ADVANCE_TS_HUB_HEALTH_URL:-http://127.0.0.1:3141/v1/health}"
HEALTH_TIMEOUT_SECONDS="${FRIDAY_ADVANCE_HEALTH_TIMEOUT_SECONDS:-180}"
RUST_WS_LABEL="${FRIDAY_ADVANCE_RUST_WS_LABEL:-com.friday.rust-agent-run-ws-server}"
READ_PROJECTION_LABEL="${FRIDAY_ADVANCE_READ_PROJECTION_LABEL:-com.friday.read-projection-server}"
TS_HUB_LABEL="${FRIDAY_ADVANCE_TS_HUB_LABEL:-com.friday.hub}"
RUST_WS_PORT="${FRIDAY_ADVANCE_RUST_WS_PORT:-48750}"
READ_PROJECTION_PORT="${FRIDAY_ADVANCE_READ_PROJECTION_PORT:-48751}"

usage() {
  cat <<'USAGE'
Usage:
  friday-advance-prod-hub-to-main.sh --signed-sha <military-signed-main-sha> [--repo <path>] [--dry-run]

This operator-run script advances the production checkout only to an explicit
military SIGN target SHA. It refuses a blind origin/main deployment because the
operator must compare this SHA to the military SIGN report before prod moves.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --repo)
      REPO_DIR="${2:-}"
      if [[ -z "${REPO_DIR}" ]]; then
        echo "FATAL: --repo requires a path." >&2
        exit 64
      fi
      shift 2
      ;;
    --signed-sha)
      SIGNED_SHA="${2:-}"
      if [[ -z "${SIGNED_SHA}" ]]; then
        echo "FATAL: --signed-sha requires a commit SHA." >&2
        exit 64
      fi
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "FATAL: unknown argument: $1" >&2
      usage >&2
      exit 64
      ;;
  esac
done

print_recovery_steps() {
  local status="$1"
  cat >&2 <<RECOVERY

[advance] FAILED with exit ${status}.
[advance] Recovery checklist:
[advance]   1. Do not rely on git rollback alone: lockfile/schema changed, so git rollback is not sufficient when native modules or Rust schema are out of sync.
[advance]   2. Re-run: pnpm install --frozen-lockfile, then verify node_modules contains better_sqlite3.node.
[advance]   3. Re-run: cargo build --release --manifest-path rust-core/Cargo.toml --bin hub_agent_run_server --bin hub_read_projection_server.
[advance]   4. Kickstart in dependency order: ${RUST_WS_LABEL} -> ${READ_PROJECTION_LABEL} -> ${TS_HUB_LABEL}.
[advance]   5. Check launchctl print and ~/.friday/launchd logs before retrying the signed advance.
RECOVERY
}

fatal() {
  local status="$1"
  shift
  echo "FATAL: $*" >&2
  print_recovery_steps "${status}"
  exit "${status}"
}

on_error() {
  local status="$?"
  print_recovery_steps "${status}"
  exit "${status}"
}
trap on_error ERR

if [[ -z "${SIGNED_SHA}" ]]; then
  fatal 64 "Refusing to deploy without an explicit military SIGN target SHA. Pass --signed-sha <sha> or set FRIDAY_ADVANCE_SIGNED_SHA."
fi

if [[ ! "${SIGNED_SHA}" =~ ^[0-9a-fA-F]{7,40}$ ]]; then
  fatal 64 "signed SHA must be a 7-40 character hexadecimal git revision."
fi

if [[ ! -e "${REPO_DIR}/.git" ]]; then
  fatal 66 "repo path is not a git checkout: ${REPO_DIR}"
fi

log() {
  echo "[advance] $*"
}

run_cmd() {
  if [[ "${DRY_RUN}" == "1" ]]; then
    echo "[advance] DRY-RUN: $*"
  else
    "$@"
  fi
}

run_in_repo() {
  if [[ "${DRY_RUN}" == "1" ]]; then
    echo "[advance] DRY-RUN: $*"
  else
    (cd "${REPO_DIR}" && "$@")
  fi
}

verify_better_sqlite3_native_binding() {
  log "verify better_sqlite3.node"
  if [[ "${DRY_RUN}" == "1" ]]; then
    echo "[advance] DRY-RUN: find node_modules -path '*better-sqlite3*better_sqlite3.node'"
    return 0
  fi

  local binding
  binding="$(
    find "${REPO_DIR}/node_modules" \
      -path '*better-sqlite3*better_sqlite3.node' \
      -type f \
      -print \
      -quit 2>/dev/null || true
  )"
  if [[ -z "${binding}" ]]; then
    fatal 70 "better_sqlite3.node was not found after pnpm install --frozen-lockfile; pnpm may have ignored native build scripts."
  fi
  run_in_repo node -e 'require("better-sqlite3");'
  log "found native binding: ${binding}"
}

kickstart_launch_agent() {
  local label="$1"
  log "kickstart ${label}"
  run_cmd launchctl kickstart -k "gui/${UID}/${label}"
}

wait_for_launch_agent_running() {
  local label="$1"
  local deadline=$((SECONDS + HEALTH_TIMEOUT_SECONDS))
  log "launchctl print gui/${UID}/${label}"
  if [[ "${DRY_RUN}" == "1" ]]; then
    echo "[advance] DRY-RUN: launchctl print gui/${UID}/${label} | grep pid"
    return 0
  fi
  until launchctl print "gui/${UID}/${label}" 2>/dev/null | grep -Eq 'pid = [0-9]+'; do
    if (( SECONDS >= deadline )); then
      fatal 71 "timed out waiting for launch agent ${label} to report a running pid."
    fi
    sleep 2
  done
}

wait_for_tcp() {
  local port="$1"
  local name="$2"
  local deadline=$((SECONDS + HEALTH_TIMEOUT_SECONDS))
  log "tcp ${name} 127.0.0.1:${port}"
  if [[ "${DRY_RUN}" == "1" ]]; then
    echo "[advance] DRY-RUN: lsof -nP -iTCP:${port} -sTCP:LISTEN"
    return 0
  fi
  until lsof -nP "-iTCP:${port}" -sTCP:LISTEN >/dev/null 2>&1; do
    if (( SECONDS >= deadline )); then
      fatal 71 "timed out waiting for ${name} to listen on 127.0.0.1:${port}."
    fi
    sleep 2
  done
}

wait_for_http() {
  local url="$1"
  local deadline=$((SECONDS + HEALTH_TIMEOUT_SECONDS))
  log "GET ${url}"
  if [[ "${DRY_RUN}" == "1" ]]; then
    echo "[advance] DRY-RUN: curl --fail --silent --show-error --max-time 5 ${url}"
    return 0
  fi

  until curl --fail --silent --show-error --max-time 5 "${url}" >/dev/null; do
    if (( SECONDS >= deadline )); then
      fatal 71 "timed out waiting for ${url} after ${HEALTH_TIMEOUT_SECONDS}s."
    fi
    sleep 2
  done
}

verify_schema_handshake() {
  log "schema handshake"
  if [[ "${DRY_RUN}" == "1" ]]; then
    echo "[advance] DRY-RUN: node scripts/ops/check-read-projection-runtime-freshness.mjs --repo-dir ${REPO_DIR} --require-current-schema --require-running-current"
    return 0
  fi

  local protocol_file="${REPO_DIR}/rust-core/crates/friday-protocol/src/lib.rs"
  local schema_version

  schema_version="$(
    sed -nE 's/^pub const CURRENT_SCHEMA_VERSION: u16 = ([0-9]+);$/\1/p' "${protocol_file}" | head -n 1
  )"
  if [[ -z "${schema_version}" ]]; then
    fatal 72 "could not read CURRENT_SCHEMA_VERSION from ${protocol_file}."
  fi
  run_in_repo node scripts/ops/check-read-projection-runtime-freshness.mjs --repo-dir "${REPO_DIR}" --require-current-schema --require-running-current
  log "CURRENT_SCHEMA_VERSION=${schema_version}; Rust bins were rebuilt before hub restart."
}

announce_signed_target() {
  log "signed target SHA: ${SIGNED_SHA}"
  log "operator must compare this SHA to the military SIGN report before continuing."
}

verify_signed_main_target() {
  if ! git -C "${REPO_DIR}" rev-parse --verify "${SIGNED_SHA}^{commit}" >/dev/null 2>&1; then
    fatal 73 "signed SHA ${SIGNED_SHA} is not present in the production checkout."
  fi
  local origin_main
  origin_main="$(git -C "${REPO_DIR}" rev-parse origin/main)"
  local signed_full
  signed_full="$(git -C "${REPO_DIR}" rev-parse "${SIGNED_SHA}^{commit}")"
  if [[ "${origin_main}" != "${signed_full}" ]]; then
    fatal 73 "signed SHA ${signed_full} does not equal current origin/main ${origin_main}; refusing to deploy an unsigned newer HEAD or a stale signed target."
  fi
}

verify_checked_out_signed_target() {
  log "verify checked out signed target"
  if [[ "${DRY_RUN}" == "1" ]]; then
    echo "[advance] DRY-RUN: git rev-parse HEAD == ${SIGNED_SHA}"
    return 0
  fi
  local checked_out
  checked_out="$(git -C "${REPO_DIR}" rev-parse HEAD)"
  local signed_full
  signed_full="$(git -C "${REPO_DIR}" rev-parse "${SIGNED_SHA}^{commit}")"
  if [[ "${checked_out}" != "${signed_full}" ]]; then
    fatal 73 "checked out HEAD ${checked_out} does not equal military signed SHA ${signed_full}."
  fi
}

log "starting signed production advance"
if [[ "${DRY_RUN}" == "1" ]]; then
  log "DRY-RUN mode: no checkout, install, cargo build, launchctl, or health mutation will run."
fi

announce_signed_target

log "git fetch origin main"
if [[ "${DRY_RUN}" == "1" ]]; then
  echo "[advance] DRY-RUN: git fetch origin main"
else
  git -C "${REPO_DIR}" fetch origin main
fi

verify_signed_main_target

log "git switch main"
if [[ "${DRY_RUN}" == "1" ]]; then
  echo "[advance] DRY-RUN: git switch main"
else
  git -C "${REPO_DIR}" switch main
fi

log "git checkout ${SIGNED_SHA}"
if [[ "${DRY_RUN}" == "1" ]]; then
  echo "[advance] DRY-RUN: git checkout ${SIGNED_SHA}"
else
  git -C "${REPO_DIR}" checkout "${SIGNED_SHA}"
fi
verify_checked_out_signed_target

run_in_repo pnpm install --frozen-lockfile
verify_better_sqlite3_native_binding

run_in_repo cargo build --release --manifest-path rust-core/Cargo.toml --bin hub_agent_run_server --bin hub_read_projection_server

kickstart_launch_agent "${RUST_WS_LABEL}"
wait_for_launch_agent_running "${RUST_WS_LABEL}"
wait_for_tcp "${RUST_WS_PORT}" "${RUST_WS_LABEL}"
kickstart_launch_agent "${READ_PROJECTION_LABEL}"
wait_for_launch_agent_running "${READ_PROJECTION_LABEL}"
wait_for_tcp "${READ_PROJECTION_PORT}" "${READ_PROJECTION_LABEL}"
kickstart_launch_agent "${TS_HUB_LABEL}"
wait_for_launch_agent_running "${TS_HUB_LABEL}"

wait_for_http "${TS_HUB_HEALTH_URL}"
verify_schema_handshake

log "signed production advance completed for ${SIGNED_SHA}"
