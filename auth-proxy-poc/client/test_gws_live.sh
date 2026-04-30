#!/usr/bin/env bash
# gws CLI live test. The CLI hardcodes upstream URLs, so we rely on
# DNS-interception of *.googleapis.com via tls-front. GOOGLE_WORKSPACE_CLI_TOKEN
# tells gws to skip its own OAuth refresh and just emit a literal Bearer token;
# the auth-proxy strips that and injects a freshly-refreshed real access token.
#
# We deliberately avoid `set -e` here so the gws output reaches the screen
# even when the command fails — otherwise diagnostics get swallowed.
set -u

export GOOGLE_WORKSPACE_CLI_TOKEN="placeholder-stripped-by-proxy"
export RUST_LOG="${RUST_LOG:-info}"

echo "[gws] gws --version:"
gws --version || echo "  (--version failed: $?)"

echo
echo "[gws] running: gws drive about get --params '{\"fields\":\"user\"}'"
gws drive about get --params '{"fields":"user"}'
rc=$?
echo
echo "[gws] exit=$rc"

if [ "$rc" -ne 0 ]; then
    echo "[gws] FAIL"
    exit 1
fi

echo "[gws] PASS"
