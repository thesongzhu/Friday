#!/usr/bin/env bash
# Echo skill — reads JSON from stdin, echoes the message field.
set -euo pipefail

INPUT=$(cat)
MESSAGE=$(echo "$INPUT" | jq -r '.message // "No message provided"')

echo "{\"echo\": \"$MESSAGE\"}"
