#!/usr/bin/env pwsh
$ErrorActionPreference = 'Stop'
Push-Location (Join-Path $PSScriptRoot '..\..')
try {
    & pnpm dlx tsx@4.21.0 (Join-Path $PSScriptRoot 'worktree-start.ts') @args
    $rc = $LASTEXITCODE
} finally {
    Pop-Location
}
exit $rc
