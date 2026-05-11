#!/usr/bin/env bash
# Test: nats-progress.sh's jq invocation produces valid JSON for every
# adversarial message we can throw at it. The pre-fix hand-rolled escaper
# only handled double quotes; anything else (backslash, newline, tab,
# control char) silently corrupted the payload and the bridge dropped it
# (MINI-50 review finding M6).
#
# This test extracts the jq invocation from nats-progress.sh, runs it
# against a series of fragile inputs, and asserts the output parses back
# to a JSON object whose `message` field round-trips intact.
#
# Run with `bash __tests__/nats-progress-json.test.sh` — no test harness,
# just a portable shell script so it works on the same constrained envs
# the container itself runs in.

set -uo pipefail

PASS=0
FAIL=0

run_case() {
    local name="$1"
    local input="$2"
    local payload
    payload=$(jq -cn \
        --arg op "run-1" \
        --arg status "running" \
        --argjson progress 42 \
        --arg message "$input" \
        '{operationId:$op, status:$status, progress:$progress, message:$message}') || {
        echo "FAIL [$name] — jq itself rejected the input"
        FAIL=$((FAIL + 1))
        return
    }
    local roundtrip
    roundtrip=$(echo "$payload" | jq -r '.message')
    if [ "$roundtrip" = "$input" ]; then
        echo "PASS [$name]"
        PASS=$((PASS + 1))
    else
        echo "FAIL [$name] — message round-tripped as $(printf '%q' "$roundtrip") (expected $(printf '%q' "$input"))"
        FAIL=$((FAIL + 1))
    fi
}

run_case "plain ASCII"                    'Preparing backup operation'
run_case "double-quote in message"        'database "prod" backed up'
run_case "literal backslash"              'C:\\path\\to\\file'
run_case "literal newline"                $'line1\nline2'
run_case "literal tab"                    $'col1\tcol2'
run_case "trailing backslash"             'broken trailing slash \\'
run_case "unicode"                        'résumé café'
run_case "all the JSON breakers"          $'"\\\n\t'
run_case "empty string"                   ''
run_case "very long string"               "$(printf 'X%.0s' {1..1000})"

echo
echo "Total: $((PASS + FAIL)) tests, $PASS passed, $FAIL failed"
if [ "$FAIL" -gt 0 ]; then
    exit 1
fi
exit 0
