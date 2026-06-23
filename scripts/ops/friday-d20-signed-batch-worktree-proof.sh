#!/usr/bin/env bash
#
# Consume an existing D20 operator-signed batch artifact through the Rust worktree driver.
#
# Truth boundary:
#   This script verifies/consumes an already-signed artifact. It never invokes operator-sign.sh,
#   never reads an operator private key, and never mints a signature.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

ARTIFACT_DIR="${FRIDAY_D20_ARTIFACT_DIR:-}"
SIGNED_BATCH_JSON="${FRIDAY_D20_SIGNED_BATCH_JSON:-}"
ACTION_JSON="${FRIDAY_D20_ACTION_JSON:-}"
WORKSPACE_ROOT="${FRIDAY_D20_WORKSPACE_ROOT:-}"
DB_PATH="${FRIDAY_D20_DB_PATH:-}"
OPERATOR_VK_PATH="${FRIDAY_OPERATOR_APPROVAL_VERIFY_KEY_PATH:-${HOME}/.friday/operator-approval.vk}"
NOW_MS="${FRIDAY_D20_NOW_MS:-}"

usage() {
  cat <<'EOF'
usage:
  scripts/ops/friday-d20-signed-batch-worktree-proof.sh [--artifact-dir /abs/d20-live-dir]
  scripts/ops/friday-d20-signed-batch-worktree-proof.sh \
    --signed-batch-json /abs/signed-batch.json \
    --action-json /abs/action.json \
    --workspace /abs/worktree \
    --db /abs/hub.sqlite \
    --operator-vk /abs/operator-approval.vk

truth:
  Verify-only D20 artifact consumer. This invokes the Rust hub_d20_signed_batch_worktree bin,
  using only the operator PUBLIC verify key. It does not sign, does not call operator-sign.sh,
  and does not read ~/.friday/operator-approve.key.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --artifact-dir)
      shift; ARTIFACT_DIR="${1:-}"
      ;;
    --signed-batch-json)
      shift; SIGNED_BATCH_JSON="${1:-}"
      ;;
    --action-json)
      shift; ACTION_JSON="${1:-}"
      ;;
    --workspace)
      shift; WORKSPACE_ROOT="${1:-}"
      ;;
    --db)
      shift; DB_PATH="${1:-}"
      ;;
    --operator-vk)
      shift; OPERATOR_VK_PATH="${1:-}"
      ;;
    --now-ms)
      shift; NOW_MS="${1:-}"
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
  shift
done

latest_artifact_dir() {
  find "${HOME}/.friday" -maxdepth 1 -type d -name 'd20-live-*' 2>/dev/null \
    | while IFS= read -r dir; do
      if [ -f "${dir}/signed-batch.json" ] \
        && [ -f "${dir}/action.json" ] \
        && [ -f "${dir}/hub.sqlite" ] \
        && { [ -d "${dir}/worktree" ] || [ -d "${dir}/scratch-worktree" ]; }; then
        printf '%s\n' "${dir}"
      fi
    done \
    | sort \
    | tail -1
}

if [ -z "${ARTIFACT_DIR}" ] && {
  [ -z "${SIGNED_BATCH_JSON}" ] || [ -z "${ACTION_JSON}" ] || [ -z "${WORKSPACE_ROOT}" ] || [ -z "${DB_PATH}" ];
}; then
  ARTIFACT_DIR="$(latest_artifact_dir || true)"
fi

if [ -n "${ARTIFACT_DIR}" ]; then
  SIGNED_BATCH_JSON="${SIGNED_BATCH_JSON:-${ARTIFACT_DIR}/signed-batch.json}"
  ACTION_JSON="${ACTION_JSON:-${ARTIFACT_DIR}/action.json}"
  DB_PATH="${DB_PATH:-${ARTIFACT_DIR}/hub.sqlite}"
  if [ -z "${WORKSPACE_ROOT}" ]; then
    if [ -d "${ARTIFACT_DIR}/worktree" ]; then
      WORKSPACE_ROOT="${ARTIFACT_DIR}/worktree"
    elif [ -d "${ARTIFACT_DIR}/scratch-worktree" ]; then
      WORKSPACE_ROOT="${ARTIFACT_DIR}/scratch-worktree"
    fi
  fi
fi

require_file() {
  local path="$1"
  local label="$2"
  if [ -z "${path}" ] || [ ! -f "${path}" ]; then
    echo "FATAL: ${label} is required and must be a file: ${path:-<unset>}" >&2
    exit 3
  fi
}

require_dir() {
  local path="$1"
  local label="$2"
  if [ -z "${path}" ] || [ ! -d "${path}" ]; then
    echo "FATAL: ${label} is required and must be a directory: ${path:-<unset>}" >&2
    exit 3
  fi
}

require_file "${SIGNED_BATCH_JSON}" signed_batch_json
require_file "${ACTION_JSON}" action_json
require_file "${DB_PATH}" hub_db
require_file "${OPERATOR_VK_PATH}" operator_public_verify_key
require_dir "${WORKSPACE_ROOT}" active_worktree

if [ -n "${ARTIFACT_DIR}" ] && [ -e "${ARTIFACT_DIR}/operator-sign.sh" ]; then
  echo "Info: operator-sign.sh exists in artifact dir but will not be executed." >&2
fi

args=(
  run --quiet --manifest-path "${REPO_ROOT}/rust-core/Cargo.toml" -p friday-hub --bin hub_d20_signed_batch_worktree --
  --db "${DB_PATH}"
  --workspace "${WORKSPACE_ROOT}"
  --signed-batch-json "${SIGNED_BATCH_JSON}"
  --action-json "${ACTION_JSON}"
  --operator-vk-path "${OPERATOR_VK_PATH}"
)
if [ -n "${NOW_MS}" ]; then
  args+=(--now-ms "${NOW_MS}")
fi

echo "truth=friday_d20_signed_batch_worktree_proof_no_private_key_no_signing"
echo "artifact_dir=${ARTIFACT_DIR:-<explicit>}"
echo "workspace=${WORKSPACE_ROOT}"
echo "db=${DB_PATH}"
echo "operator_vk=${OPERATOR_VK_PATH}"
exec cargo "${args[@]}"
