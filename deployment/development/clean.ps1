#!/usr/bin/env pwsh
# Mini Infra Development Deployment Cleanup Script (PowerShell)
# This script stops and removes all containers, networks, and volumes

$ErrorActionPreference = "Stop"

Write-Host "Stopping and removing Mini Infra development deployment..." -ForegroundColor Yellow
Write-Host "This will remove containers, networks, AND volumes (all data will be lost)!" -ForegroundColor Red
Write-Host ""

# Confirm with user
$confirmation = Read-Host "Are you sure you want to continue? (yes/no)"
if ($confirmation -ne "yes") {
    Write-Host "Cleanup cancelled." -ForegroundColor Cyan
    exit 0
}

Write-Host ""
Write-Host "Removing deployment..." -ForegroundColor Yellow

# Stop and remove containers, networks, and volumes
docker compose -f (Join-Path $PSScriptRoot "docker-compose.yaml") down -v

if ($LASTEXITCODE -eq 0) {
    Write-Host ""
    Write-Host "Mini Infra development deployment cleaned successfully!" -ForegroundColor Green
    Write-Host "All containers, networks, and volumes have been removed." -ForegroundColor Cyan
    Write-Host ""
} else {
    Write-Host ""
    Write-Host "ERROR: Failed to clean deployment" -ForegroundColor Red
    exit 1
}
