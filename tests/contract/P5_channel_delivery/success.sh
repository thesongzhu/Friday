#!/usr/bin/env bash
set -euo pipefail
"$(cd "$(dirname "${BASH_SOURCE[0]}")/../_helpers" && pwd)/run-vitest-case.sh" \
  P5_channel_delivery success \
  test/e2e/mock/friday-openclaw-parity-closure.e2e.test.ts \
  "G2 route closure: discord inbound message produces user-visible outbound message with attached artifact file" \
  "G2 route closure"
