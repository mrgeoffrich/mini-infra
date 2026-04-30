#!/usr/bin/env pwsh
# auth-proxy-poc test runner.
#
# Phase 1 (always): offline behavior tests. The proxy points at a mock-upstream
# echo server; tests assert routing, header injection, inbound auth stripping,
# pass-through, and SSE handling. No real credentials needed.
#
# Phase 2 (only if creds present): live API tests for the three target tools.
# tls-front intercepts api.anthropic.com / api.github.com / *.googleapis.com
# via DNS aliases on a separate Docker network; the test-client trusts the
# generated CA so the CLIs see normal HTTPS.
#
# Required env vars per live test:
#   ANTHROPIC_API_KEY   -> anthropic SDK + Claude Agent SDK live tests
#   GITHUB_PAT          -> gh CLI live test
#   GOOGLE_CLIENT_ID    \
#   GOOGLE_CLIENT_SECRET +-> gws CLI live test (must include drive.metadata.readonly)
#   GOOGLE_REFRESH_TOKEN /
#
# Usage:
#     .\test.ps1                              # phase 1 only
#     $env:ANTHROPIC_API_KEY = 'sk-ant-...'
#     $env:GITHUB_PAT        = 'ghp_...'
#     $env:GOOGLE_CLIENT_ID  = '...'
#     $env:GOOGLE_CLIENT_SECRET = '...'
#     $env:GOOGLE_REFRESH_TOKEN = '...'
#     .\test.ps1                              # phase 1 + all live tests

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

# Load .env from this folder if present. Format: KEY=value per line; # comments
# and blank lines ignored; optional surrounding "..." or '...' on the value.
# .env wins over anything already in the shell session.
$envFile = Join-Path $PSScriptRoot '.env'
if (Test-Path $envFile) {
    $loaded = @()
    Get-Content -Path $envFile -Encoding UTF8 | ForEach-Object {
        $line = $_.Trim().TrimStart([char]0xFEFF)
        if ($line -eq '' -or $line.StartsWith('#')) { return }
        if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$') {
            $key = $matches[1]
            $val = $matches[2]
            if (($val.StartsWith('"') -and $val.EndsWith('"')) -or
                ($val.StartsWith("'") -and $val.EndsWith("'"))) {
                $val = $val.Substring(1, $val.Length - 2)
            }
            Set-Item -Path "env:$key" -Value $val
            $loaded += $key
        }
    }
    if ($loaded.Count -gt 0) {
        Write-Host "loaded $($loaded.Count) values from .env: $($loaded -join ', ')"
    }
}

$LiveAnthropic = -not [string]::IsNullOrEmpty($env:ANTHROPIC_API_KEY)
$LiveGitHub    = -not [string]::IsNullOrEmpty($env:GITHUB_PAT)
$LiveGws       = (-not [string]::IsNullOrEmpty($env:GOOGLE_CLIENT_ID))    -and `
                 (-not [string]::IsNullOrEmpty($env:GOOGLE_CLIENT_SECRET)) -and `
                 (-not [string]::IsNullOrEmpty($env:GOOGLE_REFRESH_TOKEN))

$AnyLive = $LiveAnthropic -or $LiveGitHub -or $LiveGws

# Stash the user's real creds so phase 2 can restore them after phase 1
# clobbers them with placeholder values.
$realAnthropicKey = $env:ANTHROPIC_API_KEY
$realGitHubPat    = $env:GITHUB_PAT
$realGoogleId     = $env:GOOGLE_CLIENT_ID
$realGoogleSecret = $env:GOOGLE_CLIENT_SECRET
$realGoogleToken  = $env:GOOGLE_REFRESH_TOKEN

function Wait-Healthy {
    for ($i = 0; $i -lt 30; $i++) {
        docker compose exec -T test-client curl -fsS http://auth-proxy:8080/healthz *> $null
        if ($LASTEXITCODE -eq 0) { return }
        Start-Sleep -Seconds 1
    }
    Write-Host "TIMEOUT waiting for auth-proxy /healthz. Recent logs:"
    docker compose logs --tail 60 auth-proxy
    throw "proxy never became healthy"
}

function Invoke-Native {
    param([string]$What)
    if ($LASTEXITCODE -ne 0) { throw "$What failed (exit $LASTEXITCODE)" }
}

try {
    Write-Host "==> docker compose build"
    docker compose build
    Invoke-Native "compose build"

    # ============================================================
    # Phase 1 — offline behavior tests with mock upstream
    # ============================================================
    Write-Host ""
    Write-Host "===================================================="
    Write-Host "phase 1: offline behavior tests (mock upstream)"
    Write-Host "===================================================="

    $env:ANTHROPIC_API_KEY    = 'fake-anthropic-key'
    $env:GITHUB_PAT           = 'fake-github-pat'
    $env:ANTHROPIC_UPSTREAM   = 'http://mock-upstream:8081'
    $env:GITHUB_UPSTREAM      = 'http://mock-upstream:8081'
    $env:GOOGLE_CLIENT_ID     = ''
    $env:GOOGLE_CLIENT_SECRET = ''
    $env:GOOGLE_REFRESH_TOKEN = ''

    docker compose up -d
    Invoke-Native "compose up"

    Wait-Healthy

    docker compose exec -T test-client /work/test_proxy.sh
    Invoke-Native "phase 1 behavior tests"

    # ============================================================
    # Phase 2 — live API tests
    # ============================================================
    if ($AnyLive) {
        Write-Host ""
        Write-Host "===================================================="
        Write-Host "phase 2: live API tests"
        Write-Host "===================================================="

        $env:ANTHROPIC_API_KEY    = $realAnthropicKey
        $env:GITHUB_PAT           = $realGitHubPat
        $env:GOOGLE_CLIENT_ID     = $realGoogleId
        $env:GOOGLE_CLIENT_SECRET = $realGoogleSecret
        $env:GOOGLE_REFRESH_TOKEN = $realGoogleToken
        $env:ANTHROPIC_UPSTREAM   = 'https://api.anthropic.com'
        $env:GITHUB_UPSTREAM      = 'https://api.github.com'
        $env:GOOGLE_UPSTREAM      = 'https://www.googleapis.com'
        $env:GOOGLE_TOKEN_URL     = 'https://oauth2.googleapis.com/token'

        docker compose up -d --force-recreate --no-deps auth-proxy
        Invoke-Native "compose recreate auth-proxy"

        Wait-Healthy

        if ($LiveAnthropic) {
            Write-Host ""
            Write-Host "[live] Anthropic SDK"
            docker compose exec -T test-client python /work/test_anthropic.py
            Invoke-Native "anthropic SDK live test"

            Write-Host ""
            Write-Host "[live] Claude Agent SDK"
            docker compose exec -T test-client python /work/test_claude_agent.py
            Invoke-Native "claude agent SDK live test"
        }

        if ($LiveGitHub) {
            Write-Host ""
            Write-Host "[live] gh CLI"
            docker compose exec -T test-client /work/test_gh_live.sh
            Invoke-Native "gh CLI live test"
        }

        if ($LiveGws) {
            Write-Host ""
            Write-Host "[live] gws CLI"
            docker compose exec -T test-client /work/test_gws_live.sh
            Invoke-Native "gws CLI live test"
        }

        # ============================================================
        # Phase 3 — proof the proxy was actually in the path
        # ============================================================
        Write-Host ""
        Write-Host "===================================================="
        Write-Host "phase 3: proof the proxy was in the path"
        Write-Host "===================================================="

        Write-Host ""
        Write-Host "EVIDENCE 1 — test-client carries no real credentials"
        Write-Host "-----------------------------------------------------"
        $envCheck = @'
for v in ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN GITHUB_PAT GH_TOKEN \
         GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET GOOGLE_REFRESH_TOKEN \
         GOOGLE_WORKSPACE_CLI_TOKEN; do
    val=$(printenv "$v" 2>/dev/null)
    if [ -z "$val" ]; then
        printf '  %-30s : <unset>\n' "$v"
    elif [ "${val#placeholder}" != "$val" ]; then
        printf '  %-30s : <placeholder>\n' "$v"
    else
        printf '  %-30s : <SET TO REAL VALUE — len=%d, would mean a leak>\n' "$v" "${#val}"
    fi
done
'@
        docker compose exec -T test-client sh -c $envCheck

        Write-Host ""
        Write-Host "EVIDENCE 2 — auth-proxy access log shows every tool's traffic"
        Write-Host "-------------------------------------------------------------"
        $log = docker compose logs auth-proxy 2>&1
        $log | Select-String -Pattern '(anthropic|github|gws)/default ' | ForEach-Object { Write-Host "  $($_.Line)" }

        Write-Host ""
        Write-Host "EVIDENCE 3 — sabotage: tools fail when the proxy is bypassed"
        Write-Host "-------------------------------------------------------------"
        Write-Host "  --> stopping auth-proxy"
        docker compose stop auth-proxy 2>&1 | Out-Null

        $savedPref = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        Write-Host "  --> rerunning gh CLI test (expect failure):"
        $sabotageOutput = docker compose exec -T test-client /work/test_gh_live.sh 2>&1
        $sabotageExit = $LASTEXITCODE
        $ErrorActionPreference = $savedPref

        Write-Host "  --> restarting auth-proxy (so tear-down is clean)"
        docker compose start auth-proxy 2>&1 | Out-Null

        Write-Host ""
        Write-Host "  gh exit code with proxy stopped: $sabotageExit"
        Write-Host "  gh output excerpt:"
        $sabotageOutput | Select-Object -First 4 | ForEach-Object { Write-Host "    $_" }

        if ($sabotageExit -eq 0) {
            throw "SABOTAGE FAILED — gh succeeded without the proxy. There's a bypass; investigate."
        }
        Write-Host ""
        Write-Host "  PASS — gh failed without the proxy in the path. The proxy was the auth source."
    } else {
        Write-Host ""
        Write-Host "(phase 2 skipped — no live creds in env)"
        Write-Host ""
        Write-Host "To run live tests, set:"
        Write-Host "  `$env:ANTHROPIC_API_KEY    = 'sk-ant-...'   # anthropic SDK + claude agent SDK"
        Write-Host "  `$env:GITHUB_PAT           = 'ghp_...'      # gh CLI"
        Write-Host "  `$env:GOOGLE_CLIENT_ID     = '...'           \"
        Write-Host "  `$env:GOOGLE_CLIENT_SECRET = '...'           +-- gws CLI"
        Write-Host "  `$env:GOOGLE_REFRESH_TOKEN = '...'           /"
        Write-Host ""
        Write-Host "Quickest way to mint GOOGLE_REFRESH_TOKEN:"
        Write-Host "  1. https://console.cloud.google.com -> OAuth consent screen + Desktop OAuth client"
        Write-Host "  2. https://developers.google.com/oauthplayground -> gear icon ->"
        Write-Host "       'Use your own OAuth credentials' (paste client_id + secret)"
        Write-Host "  3. Add scope: https://www.googleapis.com/auth/drive.metadata.readonly"
        Write-Host "  4. Authorize -> exchange code for tokens -> copy refresh_token"
    }

    Write-Host ""
    Write-Host "===================================================="
    Write-Host "DONE"
    Write-Host "===================================================="
}
catch {
    Write-Host ""
    Write-Host "==> failure — dumping recent service logs for debugging"
    Write-Host "--- auth-proxy ---"
    docker compose logs --tail 80 auth-proxy 2>&1
    Write-Host "--- tls-front ---"
    docker compose logs --tail 40 tls-front 2>&1
    throw
}
finally {
    Write-Host ""
    Write-Host "==> tearing down"
    docker compose down --volumes --remove-orphans *> $null
}
