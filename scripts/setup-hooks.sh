#!/usr/bin/env bash
#
# Setup git hooks for the Friday project.
# Run once: npm run setup:hooks
#

set -euo pipefail

HOOKS_DIR=".githooks"

if [ ! -d "$HOOKS_DIR" ]; then
  echo "❌ .githooks directory not found. Run from project root."
  exit 1
fi

# Set git hooks path
git config core.hooksPath "$HOOKS_DIR"

# Make hooks executable
chmod +x "$HOOKS_DIR"/*

echo "✅ Git hooks configured → $HOOKS_DIR"
echo "   Hooks installed: $(ls "$HOOKS_DIR" | tr '\n' ' ')"
