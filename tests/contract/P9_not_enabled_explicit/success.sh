#!/usr/bin/env bash
set -euo pipefail
"$(cd "$(dirname "${BASH_SOURCE[0]}")/../_helpers" && pwd)/run-vitest-case.sh" \
  P9_not_enabled_explicit success \
  test/e2e/mock/friday-openclaw-parity-closure.e2e.test.ts \
  "F route unsupported path: observability API returns explicit not-enabled message" \
  "observability API returns explicit not-enabled message"
