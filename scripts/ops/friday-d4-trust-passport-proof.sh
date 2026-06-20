#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
RUST_ROOT="${REPO_ROOT}/rust-core"

if [[ ! -d "${RUST_ROOT}" ]]; then
  echo "FAIL: rust-core not found at ${RUST_ROOT}" >&2
  exit 1
fi

echo "Friday D4 trust/passport proof"
echo "repo=${REPO_ROOT}"
echo "truth_label=built-dark-mechanism-proof"
echo "strict_organic=0"
echo "live_done=false"
echo "operator_signature=false"
echo
echo "This harness uses scratch test databases only. It does not read operator signing keys,"
echo "does not mint a product/live grant, and does not write to the production Hub DB."
echo

run() {
  echo "+ $*"
  "$@"
}

cd "${RUST_ROOT}"

run cargo test -p friday-core trust --lib
run cargo test -p friday-core passport --lib
run cargo test -p friday-storage --test trust_grant
run cargo test -p friday-storage --test context_passport
run cargo test -p friday-operator-cli --test trust_grant_issuance
run cargo test -p friday-hub trust_grant --lib
run cargo test -p friday-hub passport_mint --lib

echo
echo "D4 proof PASS: trust ceiling, grant issuance/revoke, run/token ceilings,"
echo "and context-passport mint/fail-closed mechanisms are current-head proven."
echo "Not claimed: GO-LIVE, strict OG9 organic, D20/B4 true operator signature, or prod flag flip."
