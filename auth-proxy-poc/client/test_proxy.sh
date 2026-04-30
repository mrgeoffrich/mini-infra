#!/usr/bin/env bash
# Behavior tests against the auth-proxy + mock-upstream. No real API keys needed.
set -euo pipefail

PROXY="${PROXY_URL:-http://auth-proxy:8080}"

pass() { printf '  PASS — %s\n' "$1"; }

assert_eq() {
    local name="$1" expected="$2" actual="$3"
    if [ "$expected" = "$actual" ]; then
        pass "$name"
    else
        printf '  FAIL — %s\n    expected: %q\n    got:      %q\n' "$name" "$expected" "$actual" >&2
        exit 1
    fi
}

assert_contains() {
    local name="$1" needle="$2" haystack="$3"
    if [[ "$haystack" == *"$needle"* ]]; then
        pass "$name"
    else
        printf '  FAIL — %s\n    expected to contain: %q\n    got:                 %q\n' "$name" "$needle" "$haystack" >&2
        exit 1
    fi
}

# ---- routing -----------------------------------------------

echo "[routing]"

body=$(curl -fsS "$PROXY/healthz")
assert_eq "/healthz returns ok" "ok" "$body"

status=$(curl -s -o /dev/null -w "%{http_code}" "$PROXY/nonsense/default/foo")
assert_eq "unknown provider -> 404" "404" "$status"

status=$(curl -s -o /dev/null -w "%{http_code}" "$PROXY/anthropic")
assert_eq "missing tenant -> 400" "400" "$status"

status=$(curl -s -o /dev/null -w "%{http_code}" "$PROXY/")
assert_eq "no provider -> 400" "400" "$status"

# ---- header injection (anthropic) ---------------------------

echo
echo "[anthropic header injection]"

body=$(curl -fsS "$PROXY/anthropic/team-foo/v1/messages")

assert_eq "method preserved (GET)"     "GET"          "$(echo "$body" | jq -r .method)"
assert_eq "tenant stripped from path"  "/v1/messages" "$(echo "$body" | jq -r .path)"
assert_eq "x-api-key injected"         "fake-anthropic-key" "$(echo "$body" | jq -r '.headers["x-api-key"]')"

# ---- header injection (github) -----------------------------

echo
echo "[github header injection]"

body=$(curl -fsS "$PROXY/github/org-acme/repos/foo/bar")
assert_eq "github tenant stripped"     "/repos/foo/bar"        "$(echo "$body" | jq -r .path)"
assert_eq "github Authorization header" "Bearer fake-github-pat" "$(echo "$body" | jq -r '.headers.authorization')"

# ---- inbound auth stripping --------------------------------

echo
echo "[inbound auth is stripped before injection]"

body=$(curl -fsS -H "Authorization: Bearer client-supplied-token" "$PROXY/github/foo/x")
assert_eq "client Authorization replaced" "Bearer fake-github-pat" "$(echo "$body" | jq -r '.headers.authorization')"

body=$(curl -fsS -H "x-api-key: client-supplied-key" "$PROXY/anthropic/foo/x")
assert_eq "client x-api-key replaced" "fake-anthropic-key" "$(echo "$body" | jq -r '.headers["x-api-key"]')"

# ---- body and method pass-through --------------------------

echo
echo "[request method and body pass-through]"

body=$(curl -fsS -X POST -H "Content-Type: application/json" -d '{"hello":"world"}' "$PROXY/anthropic/t/v1/messages")
assert_eq "POST method preserved"   "POST"               "$(echo "$body" | jq -r .method)"
assert_eq "JSON body preserved"     '{"hello":"world"}'  "$(echo "$body" | jq -r .body)"

body=$(curl -fsS -X DELETE "$PROXY/github/t/repos/x/y")
assert_eq "DELETE method preserved" "DELETE" "$(echo "$body" | jq -r .method)"

# ---- query string pass-through -----------------------------

echo
echo "[query string pass-through]"

body=$(curl -fsS "$PROXY/github/t/repos?per_page=3&page=2")
assert_contains "query string preserved" "per_page=3" "$(echo "$body" | jq -r .path)"
assert_contains "all query params present" "page=2"   "$(echo "$body" | jq -r .path)"

# ---- SSE / streaming ---------------------------------------

echo
echo "[streaming SSE pass-through]"

chunks=$(curl -fsS -N "$PROXY/anthropic/t/__sse" | grep -c "^data: chunk-" || true)
assert_eq "5 SSE chunks streamed end-to-end" "5" "$chunks"

# ---- tenant-segment isolation ------------------------------

echo
echo "[tenant value does not leak into upstream path]"

body=$(curl -fsS "$PROXY/anthropic/SECRET-TENANT-NAME/v1/foo")
path=$(echo "$body" | jq -r .path)
if [[ "$path" == *"SECRET-TENANT-NAME"* ]]; then
    printf '  FAIL — tenant leaked into upstream path: %s\n' "$path" >&2
    exit 1
fi
pass "tenant name not present in upstream path ($path)"

echo
echo "ALL PASS"
