#!/bin/bash
# Install (or uninstall) the worktree cleanup launchd agent.
#
# Usage:
#   ./worktree_cleanup_install.sh           # install
#   ./worktree_cleanup_install.sh --remove  # uninstall

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
MINI_INFRA_HOME="${MINI_INFRA_HOME:-$HOME/.mini-infra}"

PLIST_LABEL="com.mini-infra.worktree-cleanup"
PLIST_SRC="$SCRIPT_DIR/worktree_cleanup.plist"
PLIST_DST="$HOME/Library/LaunchAgents/$PLIST_LABEL.plist"

if [ "${1:-}" = "--remove" ]; then
    echo "Unloading and removing worktree cleanup agent..."
    launchctl unload "$PLIST_DST" 2>/dev/null || true
    rm -f "$PLIST_DST"
    echo "Done."
    exit 0
fi

mkdir -p "$MINI_INFRA_HOME"
mkdir -p "$HOME/Library/LaunchAgents"

# Expand REPO_ROOT and MINI_INFRA_HOME placeholders in the plist template
sed \
    -e "s|REPO_ROOT|$REPO_ROOT|g" \
    -e "s|MINI_INFRA_HOME|$MINI_INFRA_HOME|g" \
    "$PLIST_SRC" > "$PLIST_DST"

chmod +x "$SCRIPT_DIR/worktree_cleanup.sh"

# Reload (unload first in case it's already loaded)
launchctl unload "$PLIST_DST" 2>/dev/null || true
launchctl load "$PLIST_DST"

echo "Worktree cleanup agent installed and loaded."
echo "  Runs every hour."
echo "  Logs: $MINI_INFRA_HOME/worktree-cleanup.log"
echo "  Dry run: $SCRIPT_DIR/worktree_cleanup.sh --dry-run"
echo "  Uninstall: $0 --remove"
