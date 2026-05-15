#!/usr/bin/env bash
# One-click launcher for codex-responses-adapter (macOS / Linux).
#
# Run with `./start.sh` from a terminal in the project root, or
# double-click in a file manager that supports it.
#
# Delegates to scripts/start.mjs which performs Node version check,
# `npm install` if needed, `npm run build` if needed, default config
# bootstrap, stale-port cleanup, then runs the adapter (which auto-
# opens the admin panel in the default browser).

set -e

# Resolve the directory this script lives in, even through symlinks.
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]:-$0}")" >/dev/null 2>&1 && pwd)"
cd "$SCRIPT_DIR"

# Make sure node is on PATH.
if ! command -v node >/dev/null 2>&1; then
  echo
  echo "[ERROR] Node.js not found on PATH."
  echo
  echo "Install Node.js 20 or newer from https://nodejs.org/ then re-run."
  echo
  exit 1
fi

# Hand off to the cross-platform launcher.
exec node "$SCRIPT_DIR/scripts/start.mjs" "$@"
