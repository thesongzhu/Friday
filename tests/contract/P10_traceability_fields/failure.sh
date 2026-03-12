#!/usr/bin/env bash
set -euo pipefail
"$(cd "$(dirname "${BASH_SOURCE[0]}")/../_helpers" && pwd)/run-vitest-case.sh" \
  P10_traceability_fields failure \
  test/e2e/mock/friday-openclaw-parity-closure.e2e.test.ts \
  "G2 delivery failure closure: primary discord send failure retries with fallback text and traceable evidence" \
  "E-CH-OUTBOUND-001" \
  "routeId: 'hub.channel.delivery.primary'" \
  "correlationId:"
