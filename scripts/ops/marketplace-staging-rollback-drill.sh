#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "${ROOT_DIR}"

TIMESTAMP="$(date -u +"%Y%m%dT%H%M%SZ")"
REPORT_PATH="${1:-docs/reports/release-readiness-2026-03-01/evidence/marketplace-rollback-drill-${TIMESTAMP}.md}"
mkdir -p "$(dirname "${REPORT_PATH}")"

DRILL_STATUS=0

append_header() {
  local commit_sha
  commit_sha="$(git rev-parse --short HEAD 2>/dev/null || echo "unknown")"
  cat >"${REPORT_PATH}" <<EOF
# Marketplace Staging Rollback Drill Evidence

- Generated at (UTC): ${TIMESTAMP}
- Git commit: ${commit_sha}
- Script: scripts/ops/marketplace-staging-rollback-drill.sh

---
EOF
}

run_step() {
  local step_name="$1"
  local command="$2"
  local log_file
  log_file="$(mktemp)"

  {
    echo
    echo "## ${step_name}"
    echo
    echo '```bash'
    echo "${command}"
    echo '```'
    echo
  } >>"${REPORT_PATH}"

  set +e
  bash -lc "${command}" >"${log_file}" 2>&1
  local exit_code=$?
  set -e

  {
    echo '```text'
    tail -n 120 "${log_file}"
    echo '```'
  } >>"${REPORT_PATH}"

  if [[ ${exit_code} -eq 0 ]]; then
    echo "- Result: PASS" >>"${REPORT_PATH}"
  else
    echo "- Result: FAIL (exit ${exit_code})" >>"${REPORT_PATH}"
    DRILL_STATUS=1
  fi

  rm -f "${log_file}"
}

append_manual_section() {
  cat >>"${REPORT_PATH}" <<'EOF'

---

## Manual Staging Checks (Operator Required)

1. Commerce runtime rollback check:
   - Set `FRIDAY_MARKETPLACE_COMMERCE_ENABLED=false` in staging.
   - Restart service.
   - Confirm marketplace commerce routes are unavailable (expect non-200 on marketplace endpoints).
   - Restore previous value and restart service.

2. Install gate rollback check:
   - Set `FRIDAY_MARKETPLACE_INSTALL_REQUIRED=false` in staging.
   - Run a controlled workflow listing execution without install.
   - Confirm run is allowed when entitlement exists.
   - Restore previous value and restart service.

3. Agent-install rollback check:
   - Set `FRIDAY_MARKETPLACE_AGENT_ASSET_ENABLED=false` in staging.
   - Attempt `agent` install.
   - Confirm failure code `INSTALL_AGENT_ASSET_DISABLED`.
   - Restore previous value and restart service.

4. Record outcome in:
   - `docs/task/marketplace-staging-rollback-drill-record-template.md`
EOF
}

append_header

run_step \
  "Baseline Marketplace Integration Matrix" \
  "FRIDAY_MARKETPLACE_COMMERCE_ENABLED=true FRIDAY_MARKETPLACE_INSTALL_REQUIRED=true npm run -s test -- test/integration/marketplace/friday-marketplace-install-closure.test.ts test/integration/marketplace/friday-marketplace-workflow-one-time-run-gate.test.ts test/integration/marketplace/friday-marketplace-duplicate-checkout-callback.test.ts"

run_step \
  "Rollback Toggle Validation: install gate off" \
  "FRIDAY_MARKETPLACE_INSTALL_REQUIRED=false npm run -s test -- test/unit/marketplace/engine/entitlement-guard.test.ts"

run_step \
  "Rollback Toggle Validation: agent install off" \
  "FRIDAY_MARKETPLACE_AGENT_ASSET_ENABLED=false npm run -s test -- test/unit/marketplace/engine/install-dispatcher.test.ts"

run_step \
  "Migration Integrity" \
  "npm run -s check:migrations"

append_manual_section

echo "Rollback drill evidence written to: ${REPORT_PATH}"
exit "${DRILL_STATUS}"
