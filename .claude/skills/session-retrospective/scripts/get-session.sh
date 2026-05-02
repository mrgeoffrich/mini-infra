#!/bin/bash
# Get current session JSONL content for retrospective analysis
# Usage: get-session.sh [session-id]
# If no session-id provided, uses current session from CLAUDE_SESSION_ID env var

set -e

SESSION_ID="${1:-$CLAUDE_SESSION_ID}"
PROJECTS_DIR="$HOME/.claude/projects"

if [ -z "$SESSION_ID" ]; then
  echo "Error: No session ID provided and CLAUDE_SESSION_ID not set" >&2
  exit 1
fi

# Find the session file (could be in any project subdirectory)
SESSION_FILE=$(find "$PROJECTS_DIR" -name "${SESSION_ID}.jsonl" -type f 2>/dev/null | head -1)

if [ -z "$SESSION_FILE" ] || [ ! -f "$SESSION_FILE" ]; then
  echo "Error: Session file not found for ID: $SESSION_ID" >&2
  exit 1
fi

# Output session content
cat "$SESSION_FILE"
