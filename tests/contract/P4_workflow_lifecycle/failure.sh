#!/usr/bin/env bash
set -euo pipefail
"$(cd "$(dirname "${BASH_SOURCE[0]}")/../_helpers" && pwd)/run-vitest-case.sh" \
  P4_workflow_lifecycle failure \
  test/e2e/api/friday-api-workflows-routes.test.ts \
  "archived_workflow_cannot_start_run" \
  "archived_workflow_cannot_start_run"
