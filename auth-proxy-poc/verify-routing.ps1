#!/usr/bin/env pwsh
# Demonstrates the four mechanisms that force test-client to send its
# CLI traffic through the proxy:
#
#   1. Docker network alias on tls-front impersonates upstream hostnames
#      (api.anthropic.com, api.github.com, *.googleapis.com) on client-net.
#   2. test-client lives on client-net so its DNS lookups for those
#      hostnames hit the alias and resolve to tls-front's internal IP,
#      not the real public CDN.
#   3. tls-front holds a self-signed cert covering all those hostnames;
#      test-client's entrypoint installs the local CA so the TLS handshake
#      validates.
#   4. auth-proxy lives ONLY on proxy-net (no aliases), so its outbound
#      lookups still hit the real public DNS — no infinite loop.
#
# We boot the stack with placeholder creds (no real API calls happen),
# probe DNS + TLS from inside the relevant containers, then tear down.

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

$projName = 'auth-proxy-poc'

# Use placeholders — this demo doesn't make any live API calls.
$env:ANTHROPIC_API_KEY    = 'fake'
$env:GITHUB_PAT           = 'fake'
$env:ANTHROPIC_UPSTREAM   = 'http://mock-upstream:8081'
$env:GITHUB_UPSTREAM      = 'http://mock-upstream:8081'
$env:GOOGLE_CLIENT_ID     = ''
$env:GOOGLE_CLIENT_SECRET = ''
$env:GOOGLE_REFRESH_TOKEN = ''

try {
    Write-Host "==> bringing up stack"
    docker compose up -d 2>&1 | Out-Null

    for ($i = 0; $i -lt 30; $i++) {
        docker compose exec -T test-client curl -fsS http://auth-proxy:8080/healthz *> $null
        if ($LASTEXITCODE -eq 0) { break }
        Start-Sleep -Seconds 1
    }

    Write-Host ""
    Write-Host "===================================================="
    Write-Host "1. DNS from test-client (on client-net with aliases)"
    Write-Host "===================================================="
    Write-Host "Expectation: upstream hostnames resolve to tls-front's"
    Write-Host "internal IP (172.x.x.x), NOT the public CDN."
    Write-Host ""
    docker compose exec -T test-client getent hosts `
        api.anthropic.com api.github.com www.googleapis.com `
        oauth2.googleapis.com auth-proxy tls-front

    Write-Host ""
    Write-Host "===================================================="
    Write-Host "2. DNS from a container ONLY on proxy-net (no aliases)"
    Write-Host "===================================================="
    Write-Host "Expectation: same names resolve to public internet IPs."
    Write-Host "Proves the alias on client-net is what causes interception."
    Write-Host ""
    docker run --rm --network "${projName}_proxy-net" alpine:3.20 `
        sh -c 'getent hosts api.anthropic.com api.github.com www.googleapis.com oauth2.googleapis.com 2>/dev/null'

    Write-Host ""
    Write-Host "===================================================="
    Write-Host "3. TLS cert presented to test-client at api.anthropic.com"
    Write-Host "===================================================="
    Write-Host "Expectation: issuer = auth-proxy-poc-ca, subject = our cert."
    Write-Host "test-client trusts this CA because entrypoint.sh installed it."
    Write-Host ""
    docker compose exec -T test-client sh -c `
        "echo | openssl s_client -connect api.anthropic.com:443 -servername api.anthropic.com 2>/dev/null | openssl x509 -noout -issuer -subject -ext subjectAltName 2>/dev/null"

    Write-Host ""
    Write-Host "===================================================="
    Write-Host "4. Network membership"
    Write-Host "===================================================="
    Write-Host "client-net (carries the upstream-hostname aliases):"
    docker network inspect "${projName}_client-net" --format '{{range .Containers}}  - {{.Name}} ({{.IPv4Address}}){{println}}{{end}}'
    Write-Host "proxy-net (no aliases — auth-proxy uses real DNS here):"
    docker network inspect "${projName}_proxy-net" --format '{{range .Containers}}  - {{.Name}} ({{.IPv4Address}}){{println}}{{end}}'
}
finally {
    Write-Host "==> tearing down"
    docker compose down --volumes --remove-orphans *> $null
}
