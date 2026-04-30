#!/usr/bin/env bash
# `gh` lives test — DNS-intercepts api.github.com to the tls-front sidecar.
# We don't set GH_HOST: gh defaults to api.github.com and the network alias
# routes it to caddy, which forwards to auth-proxy. The proxy strips the
# placeholder GH_TOKEN and injects the real PAT.
set -euo pipefail

# gh refuses to call the API with no token configured.
export GH_TOKEN="placeholder-stripped-by-proxy"

echo "[gh] gh api /user via api.github.com -> tls-front -> auth-proxy..."
body=$(gh api /user)
login=$(printf '%s' "$body" | jq -r .login)

if [ -z "$login" ] || [ "$login" = "null" ]; then
    echo "FAIL: no login in response: $body" >&2
    exit 1
fi

echo "[gh] PASS — login=$login"
