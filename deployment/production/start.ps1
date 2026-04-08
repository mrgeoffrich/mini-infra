#!/usr/bin/env pwsh
# Mini Infra Production Deployment Startup Script (PowerShell)
# This script starts the production Mini Infra deployment using Docker Compose

$ErrorActionPreference = "Stop"

# Check if .env file exists
$envFile = Join-Path $PSScriptRoot ".env"
if (-not (Test-Path $envFile)) {
    Write-Host "ERROR: .env file not found at: $envFile" -ForegroundColor Red
    Write-Host ""
    Write-Host "Please create a .env file in the deployment/production/ directory." -ForegroundColor Yellow
    Write-Host "You can use the following template as a starting point:" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "  SESSION_SECRET=<generate with: openssl rand -base64 32>"
    Write-Host "  API_KEY_SECRET=<generate with: openssl rand -base64 32>"
    Write-Host ""
    exit 1
}

Write-Host "Starting Mini Infra production deployment..." -ForegroundColor Green
Write-Host "Using .env file: $envFile" -ForegroundColor Cyan
Write-Host ""

# Start Docker Compose with explicit env file
docker compose --env-file $envFile -f (Join-Path $PSScriptRoot "docker-compose.yaml") up -d

if ($LASTEXITCODE -eq 0) {
    Write-Host ""
    Write-Host "Mini Infra started successfully!" -ForegroundColor Green
    Write-Host ""
    Write-Host "Useful commands:" -ForegroundColor Cyan
    Write-Host "  View logs:    docker compose -f deployment/production/docker-compose.yaml logs -f"
    Write-Host "  Check status: docker compose -f deployment/production/docker-compose.yaml ps"
    Write-Host "  Stop:         docker compose -f deployment/production/docker-compose.yaml down"
    Write-Host ""
} else {
    Write-Host ""
    Write-Host "ERROR: Failed to start Mini Infra" -ForegroundColor Red
    exit 1
}
