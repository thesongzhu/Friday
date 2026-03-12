#!/usr/bin/env bash
set -euo pipefail
"$(cd "$(dirname "${BASH_SOURCE[0]}")/../_helpers" && pwd)/run-vitest-case.sh" \
  P4_workflow_lifecycle success \
  test/e2e/api/friday-api-workflows-routes.test.ts \
  "start_run" \
  "start_run"
