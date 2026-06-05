#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

if ! command -v detect-secrets-hook >/dev/null 2>&1; then
  echo "BLOCKER: detect-secrets-hook not found" >&2
  exit 2
fi

paths_file="$(mktemp)"
trap 'rm -f "$paths_file"' EXIT

git ls-files -z >"$paths_file"
git ls-files -z --others --exclude-standard >>"$paths_file"

if [[ ! -s "$paths_file" ]]; then
  echo "[mission-spine-secret-scan] no tracked or untracked files to scan"
  exit 0
fi

xargs -0 detect-secrets-hook <"$paths_file"
echo "[mission-spine-secret-scan] tracked + untracked secret scan passed"
