#!/bin/bash
# Mini Infra Worktree Cleanup
#
# Runs from the main repo checkout (not a worktree). Scans all git worktrees,
# checks via GitHub CLI whether each branch's PR has been merged, and for
# merged ones:
#   1. Deletes the Colima VM
#   2. Removes the git worktree
#   3. Removes the port registry entry from ~/.mini-infra/worktrees.json
#
# Usage: ./worktree_cleanup.sh [--dry-run] [--repo <owner/repo>]
#
# Options:
#   --dry-run   Show what would be cleaned up without making any changes
#   --repo      GitHub repo (default: auto-detected from git remote)
#
# Designed to be run as a launchd agent (see worktree_cleanup.plist).

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

MINI_INFRA_HOME="${MINI_INFRA_HOME:-$HOME/.mini-infra}"
REGISTRY_FILE="$MINI_INFRA_HOME/worktrees.json"

RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[0;33m'
GRAY='\033[0;90m'
NC='\033[0m'

ts()      { date '+%H:%M:%S'; }
log_info()  { echo -e "${CYAN}[$(ts)] $1${NC}"; }
log_ok()    { echo -e "${GREEN}[$(ts)] ✓ $1${NC}"; }
log_warn()  { echo -e "${YELLOW}[$(ts)] ⚠ $1${NC}"; }
log_skip()  { echo -e "${GRAY}[$(ts)] · $1${NC}"; }
log_error() { echo -e "${RED}[$(ts)] ✗ $1${NC}"; }

# ---------------------------------------------------------------------------
# Parse args
# ---------------------------------------------------------------------------
DRY_RUN=false
REPO=""

while [ $# -gt 0 ]; do
    case "$1" in
        --dry-run) DRY_RUN=true; shift ;;
        --repo) REPO="$2"; shift 2 ;;
        -h|--help)
            sed -n '2,14p' "$0"
            exit 0
            ;;
        *) log_error "Unknown arg: $1"; exit 1 ;;
    esac
done

if [ "$DRY_RUN" = true ]; then
    log_warn "DRY RUN — no changes will be made"
fi

# ---------------------------------------------------------------------------
# Prerequisites
# ---------------------------------------------------------------------------
if ! command -v gh >/dev/null 2>&1; then
    log_error "gh CLI is not installed. Install with: brew install gh"
    exit 1
fi
if ! command -v colima >/dev/null 2>&1; then
    log_error "colima is not installed. Install with: brew install colima"
    exit 1
fi
if ! command -v python3 >/dev/null 2>&1; then
    log_error "python3 is required for registry updates"
    exit 1
fi

# Auto-detect repo from remote if not passed
if [ -z "$REPO" ]; then
    REPO=$(cd "$REPO_ROOT" && gh repo view --json nameWithOwner --jq '.nameWithOwner' 2>/dev/null || echo "")
    if [ -z "$REPO" ]; then
        log_error "Could not detect GitHub repo. Pass --repo <owner/repo>"
        exit 1
    fi
fi
log_info "Repo: $REPO"

# Ensure we're running from the main checkout, not inside a worktree
MAIN_WORKTREE=$(cd "$REPO_ROOT" && git worktree list --porcelain | awk '/^worktree / && !seen { print $2; seen=1 }')
if [ "$REPO_ROOT" != "$MAIN_WORKTREE" ]; then
    log_error "Must be run from the main checkout ($MAIN_WORKTREE), not a worktree ($REPO_ROOT)"
    exit 1
fi

# ---------------------------------------------------------------------------
# Derive the Colima profile name from a worktree directory basename.
# Mirrors the normalisation in worktree_start.sh.
# ---------------------------------------------------------------------------
colima_profile() {
    echo "$1" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9-' '-' | sed 's/--*/-/g; s/^-//; s/-$//'
}

# ---------------------------------------------------------------------------
# Remove a profile from the port registry (best-effort, non-fatal)
# ---------------------------------------------------------------------------
remove_from_registry() {
    local profile="$1"
    if [ ! -f "$REGISTRY_FILE" ]; then return; fi
    python3 - "$REGISTRY_FILE" "$profile" <<'PY'
import json, sys

reg_path, profile = sys.argv[1], sys.argv[2]
try:
    with open(reg_path) as f:
        reg = json.load(f)
    wt = reg.get("worktrees", {})
    if profile in wt:
        del wt[profile]
        reg["worktrees"] = wt
        with open(reg_path, "w") as f:
            json.dump(reg, f, indent=2, sort_keys=True)
        print(f"Removed '{profile}' from registry")
    else:
        print(f"'{profile}' not in registry (already clean)")
except Exception as e:
    print(f"Registry update skipped: {e}", file=sys.stderr)
PY
}

# ---------------------------------------------------------------------------
# Main loop — iterate over non-main worktrees
# ---------------------------------------------------------------------------
log_info "Scanning worktrees in $REPO_ROOT..."

cleaned=0
skipped=0

while IFS= read -r line; do
    # Parse porcelain output into (path, branch) pairs
    if [[ "$line" =~ ^worktree\ (.+)$ ]]; then
        wt_path="${BASH_REMATCH[1]}"
        wt_branch=""
        wt_detached=false
    elif [[ "$line" =~ ^branch\ refs/heads/(.+)$ ]]; then
        wt_branch="${BASH_REMATCH[1]}"
    elif [[ "$line" == "detached" ]]; then
        wt_detached=true
    elif [ -z "$line" ]; then
        # Blank line = end of a stanza — process it
        [ -z "$wt_path" ] && continue

        # Skip the main checkout
        if [ "$wt_path" = "$MAIN_WORKTREE" ]; then
            log_skip "Skipping main checkout"
            wt_path=""
            continue
        fi

        wt_name="$(basename "$wt_path")"
        profile="$(colima_profile "$wt_name")"

        if [ "$wt_detached" = true ] || [ -z "$wt_branch" ]; then
            log_skip "$wt_name — detached HEAD, skipping"
            ((skipped++)) || true
            wt_path=""
            continue
        fi

        log_info "Checking $wt_name (branch: $wt_branch)"

        # Age check — skip worktrees younger than 24 hours
        wt_age_hours=$(python3 -c "
import os, time
try:
    mtime = os.path.getmtime('$wt_path')
    print(int((time.time() - mtime) / 3600))
except Exception:
    print(0)
")
        if [ "${wt_age_hours:-0}" -lt 2 ]; then
            log_skip "$wt_name — only ${wt_age_hours}h old (< 2h), skipping"
            ((skipped++)) || true
            wt_path=""
            continue
        fi

        # Query GitHub for PR state
        pr_state=$(gh pr view "$wt_branch" --repo "$REPO" --json state --jq '.state' 2>/dev/null || echo "NOT_FOUND")

        if [ "$pr_state" != "MERGED" ]; then
            log_skip "$wt_name — PR state: ${pr_state:-unknown}, skipping"
            ((skipped++)) || true
            wt_path=""
            continue
        fi

        log_ok "$wt_name — PR merged, folder ${wt_age_hours}h old — cleaning up"

        if [ "$DRY_RUN" = true ]; then
            echo "  [dry-run] colima delete $profile --force"
            echo "  [dry-run] git worktree remove --force $wt_path  (${wt_age_hours}h old)"
            echo "  [dry-run] remove '$profile' from $REGISTRY_FILE"
            ((cleaned++)) || true
            wt_path=""
            continue
        fi

        # 1. Delete Colima VM (non-fatal — may not exist if never started)
        if colima status "$profile" >/dev/null 2>&1; then
            log_info "Deleting Colima VM: $profile"
            colima delete "$profile" --force 2>/dev/null && log_ok "Colima VM deleted" || log_warn "Colima delete returned non-zero (continuing)"
        else
            log_skip "No Colima VM for $profile"
        fi

        # 2. Remove git worktree
        log_info "Removing git worktree: $wt_path"
        cd "$REPO_ROOT" && git worktree remove --force "$wt_path" && log_ok "Worktree removed" || log_warn "git worktree remove returned non-zero (continuing)"

        # 3. Clean up port registry
        remove_from_registry "$profile"

        ((cleaned++)) || true
        wt_path=""
    fi
done < <(cd "$REPO_ROOT" && git worktree list --porcelain && echo "")

cd "$REPO_ROOT" && git worktree prune 2>/dev/null || true

echo ""
log_info "Done — cleaned: $cleaned, skipped: $skipped"
