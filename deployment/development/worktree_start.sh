#!/bin/bash
# Thin wrapper — logic lives in worktree-start.ts.
# Kept as .sh so CLAUDE.md / docs / user muscle memory keep working.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
exec npx --prefix "$PROJECT_ROOT" tsx "$SCRIPT_DIR/worktree-start.ts" "$@"
