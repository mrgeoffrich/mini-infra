#!/usr/bin/env pwsh
# Sanity-checks the GOOGLE_* values in .env by doing an OAuth refresh-token
# exchange against oauth2.googleapis.com directly — no proxy, no docker, no gws.
# If this fails with invalid_grant, the credentials in .env are wrong; the
# auth-proxy can't possibly succeed until you fix them.

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

$envFile = Join-Path $PSScriptRoot '.env'
if (-not (Test-Path $envFile)) {
    throw "no .env at $envFile"
}

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
    }
}

function Show-Field {
    param([string]$Name)
    $val = [Environment]::GetEnvironmentVariable($Name)
    if ([string]::IsNullOrEmpty($val)) {
        Write-Host "  $Name : <empty or unset>"
        return
    }
    $prefix = $val.Substring(0, [Math]::Min(8, $val.Length))
    $suffix = if ($val.Length -gt 16) { $val.Substring($val.Length - 4) } else { "" }
    Write-Host "  $Name : len=$($val.Length) prefix='$prefix...' suffix='...$suffix'"
}

Write-Host "Loaded values (truncated):"
Show-Field 'GOOGLE_CLIENT_ID'
Show-Field 'GOOGLE_CLIENT_SECRET'
Show-Field 'GOOGLE_REFRESH_TOKEN'

Write-Host ""
Write-Host "POSTing refresh_token grant to oauth2.googleapis.com..."

$body = @{
    client_id     = $env:GOOGLE_CLIENT_ID
    client_secret = $env:GOOGLE_CLIENT_SECRET
    refresh_token = $env:GOOGLE_REFRESH_TOKEN
    grant_type    = 'refresh_token'
}

try {
    $resp = Invoke-RestMethod `
        -Uri 'https://oauth2.googleapis.com/token' `
        -Method Post `
        -Body $body `
        -ContentType 'application/x-www-form-urlencoded'
    Write-Host "SUCCESS:"
    Write-Host "  access_token: $($resp.access_token.Substring(0, [Math]::Min(20, $resp.access_token.Length)))..."
    Write-Host "  expires_in:   $($resp.expires_in) seconds"
    Write-Host "  scope:        $($resp.scope)"
    Write-Host ""
    Write-Host "Credentials are valid. The auth-proxy should be able to use them."
}
catch {
    $msg = $_.Exception.Message
    $detail = $_.ErrorDetails.Message
    Write-Host "FAILED:"
    Write-Host "  $msg"
    if ($detail) {
        Write-Host "  body: $detail"
    }
    Write-Host ""
    Write-Host "Common causes:"
    Write-Host "  - copy/paste truncated the value (the refresh_token is usually >100 chars)"
    Write-Host "  - the refresh_token was minted with a different client_id/secret pair"
    Write-Host "  - the refresh_token was revoked (e.g. token-limit eviction, password change)"
    Write-Host "  - the OAuth client is in 'Testing' status and the token aged out (7 days)"
    exit 1
}
