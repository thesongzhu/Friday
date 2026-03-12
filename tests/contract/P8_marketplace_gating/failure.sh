#!/usr/bin/env bash
set -euo pipefail
"$(cd "$(dirname "${BASH_SOURCE[0]}")/../_helpers" && pwd)/run-vitest-case.sh" \
  P8_marketplace_gating failure \
  test/integration/marketplace/friday-marketplace-duplicate-checkout-callback.test.ts \
  "rejects duplicate callback replay and keeps entitlement grant singular" \
  "rejects duplicate callback replay"
