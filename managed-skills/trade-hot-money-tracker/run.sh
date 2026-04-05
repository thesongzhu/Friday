#!/usr/bin/env bash
set -euo pipefail
INPUT=$(cat)
python3 "$(dirname "$0")/main.py" <<< "$INPUT"
