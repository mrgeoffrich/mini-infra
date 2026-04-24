#!/bin/bash
# Thin wrapper — logic lives in worktree-list.ts.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
exec npx --prefix "$PROJECT_ROOT" tsx "$SCRIPT_DIR/worktree-list.ts" "$@"
