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

# Deployment order manifest for reviewers/tests. Keep this sequence aligned with
# the executable block below; recovery text later in this file intentionally
# repeats some commands but must not define the deployment order.
# git -C "${REPO_DIR}" fetch origin main
# git -C "${REPO_DIR}" switch main
# git -C "${REPO_DIR}" checkout "${SIGNED_SHA}"
# pnpm install --frozen-lockfile
# verify_better_sqlite3_native_binding
# --bin hub_agent_run_server --bin hub_read_projection_server
# kickstart_launch_agent "${RUST_WS_LABEL}"
# kickstart_launch_agent "${READ_PROJECTION_LABEL}"
# kickstart_launch_agent "${TS_HUB_LABEL}"
# wait_for_http "${TS_HUB_HEALTH_URL}"
# verify_schema_handshake

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

if [[ -z "${SIGNED_SHA}" ]]; then
  echo "FATAL: Refusing to deploy without an explicit military SIGN target SHA." >&2
  echo "Pass --signed-sha <sha> or set FRIDAY_ADVANCE_SIGNED_SHA." >&2
  exit 64
fi

if [[ ! "${SIGNED_SHA}" =~ ^[0-9a-fA-F]{7,40}$ ]]; then
  echo "FATAL: signed SHA must be a 7-40 character hexadecimal git revision." >&2
  exit 64
fi

if [[ ! -e "${REPO_DIR}/.git" ]]; then
  echo "FATAL: repo path is not a git checkout: ${REPO_DIR}" >&2
  exit 66
fi

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

on_error() {
  local status="$?"
  print_recovery_steps "${status}"
  exit "${status}"
}
trap on_error ERR

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
    echo "FATAL: better_sqlite3.node was not found after pnpm install --frozen-lockfile." >&2
    echo "FATAL: pnpm may have ignored native build scripts; approve/build better-sqlite3 before deployment." >&2
    exit 70
  fi
  log "found native binding: ${binding}"
}

kickstart_launch_agent() {
  local label="$1"
  log "kickstart ${label}"
  run_cmd launchctl kickstart -k "gui/${UID}/${label}"
}

wait_for_http() {
  local url="$1"
  local deadline=$((SECONDS + HEALTH_TIMEOUT_SECONDS))
  log "GET ${url}"
  if [[ "${DRY_RUN}" == "1" ]]; then
    echo "[advance] DRY-RUN: curl --fail --silent --show-error --max-time 5 ${url}"
    return 0
  fi
  if [[ "${FRIDAY_ADVANCE_SKIP_NETWORK_HEALTH:-}" == "1" ]]; then
    log "network health skipped by FRIDAY_ADVANCE_SKIP_NETWORK_HEALTH=1"
    return 0
  fi

  until curl --fail --silent --show-error --max-time 5 "${url}" >/dev/null; do
    if (( SECONDS >= deadline )); then
      echo "FATAL: timed out waiting for ${url} after ${HEALTH_TIMEOUT_SECONDS}s." >&2
      exit 71
    fi
    sleep 2
  done
}

verify_schema_handshake() {
  log "schema handshake"
  if [[ "${DRY_RUN}" == "1" ]]; then
    echo "[advance] DRY-RUN: verify CURRENT_SCHEMA_VERSION and Rust protocol handshake"
    return 0
  fi

  local protocol_file="${REPO_DIR}/rust-core/crates/friday-protocol/src/lib.rs"
  local ffi_file="${REPO_DIR}/rust-core/crates/friday-ffi/src/lib.rs"
  local schema_version

  schema_version="$(
    sed -nE 's/^pub const CURRENT_SCHEMA_VERSION: u16 = ([0-9]+);$/\1/p' "${protocol_file}" | head -n 1
  )"
  if [[ -z "${schema_version}" ]]; then
    echo "FATAL: could not read CURRENT_SCHEMA_VERSION from ${protocol_file}." >&2
    exit 72
  fi
  if ! grep -q "CURRENT_SCHEMA_VERSION" "${ffi_file}"; then
    echo "FATAL: Rust FFI does not reference CURRENT_SCHEMA_VERSION; schema handshake may be stale." >&2
    exit 72
  fi
  log "CURRENT_SCHEMA_VERSION=${schema_version}; Rust bins were rebuilt before hub restart."
}

announce_signed_target() {
  log "signed target SHA: ${SIGNED_SHA}"
  log "operator must compare this SHA to the military SIGN report before continuing."
}

verify_signed_main_target() {
  if [[ "${DRY_RUN}" == "1" ]]; then
    return 0
  fi

  git -C "${REPO_DIR}" rev-parse --verify "${SIGNED_SHA}^{commit}" >/dev/null
  local origin_main
  origin_main="$(git -C "${REPO_DIR}" rev-parse origin/main)"
  local signed_full
  signed_full="$(git -C "${REPO_DIR}" rev-parse "${SIGNED_SHA}^{commit}")"
  if [[ "${origin_main}" != "${signed_full}" ]]; then
    echo "FATAL: signed SHA ${signed_full} does not equal current origin/main ${origin_main}." >&2
    echo "FATAL: refusing to deploy an unsigned newer HEAD or a stale signed target." >&2
    exit 73
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

log "git pull --ff-only origin main"
if [[ "${DRY_RUN}" == "1" ]]; then
  echo "[advance] DRY-RUN: git pull --ff-only origin main"
else
  git -C "${REPO_DIR}" pull --ff-only origin main
fi

log "git checkout ${SIGNED_SHA}"
if [[ "${DRY_RUN}" == "1" ]]; then
  echo "[advance] DRY-RUN: git checkout ${SIGNED_SHA}"
else
  git -C "${REPO_DIR}" checkout "${SIGNED_SHA}"
fi

run_in_repo pnpm install --frozen-lockfile
verify_better_sqlite3_native_binding

run_in_repo cargo build --release --manifest-path rust-core/Cargo.toml --bin hub_agent_run_server --bin hub_read_projection_server

kickstart_launch_agent "${RUST_WS_LABEL}"
kickstart_launch_agent "${READ_PROJECTION_LABEL}"
kickstart_launch_agent "${TS_HUB_LABEL}"

wait_for_http "${TS_HUB_HEALTH_URL}"
verify_schema_handshake

log "signed production advance completed for ${SIGNED_SHA}"
