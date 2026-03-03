#!/usr/bin/env bash
# Lists the top N files of a given extension by line count (descending)
# Usage: ./scripts/top-files-by-lines.sh <extension> [count]
# Example: ./scripts/top-files-by-lines.sh ts 20

EXT="${1:?Usage: $0 <extension> [count]}"
COUNT="${2:-20}"

find . -name "*.${EXT}" -not -path '*/node_modules/*' -not -path '*/dist/*' -not -path '*/.git/*' \
  | xargs wc -l 2>/dev/null \
  | grep -v ' total$' \
  | sort -rn \
  | head -n "$COUNT"
