#!/usr/bin/env bash
set -euo pipefail

INPUT=$(cat)
node "$(dirname "$0")/index.mjs" "$INPUT"
