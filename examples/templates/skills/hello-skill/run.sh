#!/usr/bin/env bash
set -euo pipefail

INPUT=$(cat)
NAME=$(echo "$INPUT" | sed -n 's/.*"name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')

if [ -z "$NAME" ]; then
  NAME="world"
fi

echo "{\"greeting\":\"Hello, ${NAME}!\"}"
