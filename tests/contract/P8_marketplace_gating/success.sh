#!/usr/bin/env bash
set -euo pipefail
"$(cd "$(dirname "${BASH_SOURCE[0]}")/../_helpers" && pwd)/run-vitest-case.sh" \
  P8_marketplace_gating success \
  test/integration/marketplace/friday-marketplace-workflow-one-time-run-gate.test.ts \
  "requires install before workflow run and allows run after install" \
  "requires install before workflow run and allows run after install"
