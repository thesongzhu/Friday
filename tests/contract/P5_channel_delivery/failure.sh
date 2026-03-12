#!/usr/bin/env bash
set -euo pipefail
"$(cd "$(dirname "${BASH_SOURCE[0]}")/../_helpers" && pwd)/run-vitest-case.sh" \
  P5_channel_delivery failure \
  test/e2e/mock/friday-openclaw-parity-closure.e2e.test.ts \
  "G2 delivery failure closure: primary discord send failure retries with fallback text and traceable evidence" \
  "G2 delivery failure closure" \
  "E-CH-OUTBOUND-001"
