#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
export CONTRACT_ENV=local
source "${ROOT_DIR}/tests/contract/_helpers/contract-script-list.sh"

for script in "${CONTRACT_SCRIPTS[@]}"; do
  echo "[contract-local] running ${script}"
  (cd "${ROOT_DIR}" && bash "${script}")
done
