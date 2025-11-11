#!/usr/bin/env pwsh
# Mini Infra Development Deployment Startup Script (PowerShell)
# This script builds and starts the development Mini Infra deployment using Docker Compose
# It builds from the local Dockerfile instead of pulling from ghcr.io

$ErrorActionPreference = "Stop"

# Check if .env file exists
$envFile = Join-Path $PSScriptRoot ".env"
if (-not (Test-Path $envFile)) {
    Write-Host "ERROR: .env file not found at: $envFile" -ForegroundColor Red
    Write-Host ""
    Write-Host "Please create a .env file in the deployment/development/ directory." -ForegroundColor Yellow
    Write-Host "You can use the following template as a starting point:" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "  SESSION_SECRET=<generate with: openssl rand -base64 32>"
    Write-Host "  API_KEY_SECRET=<generate with: openssl rand -base64 32>"
    Write-Host "  GOOGLE_CLIENT_ID=your_google_client_id"
    Write-Host "  GOOGLE_CLIENT_SECRET=your_google_client_secret"
    Write-Host "  GOOGLE_CALLBACK_URL=http://localhost:5000/auth/google/callback"
    Write-Host ""
    exit 1
}

Write-Host "Building and starting Mini Infra development deployment..." -ForegroundColor Green
Write-Host "Using .env file: $envFile" -ForegroundColor Cyan
Write-Host "Building from local Dockerfile..." -ForegroundColor Cyan
Write-Host ""

# Build and start Docker Compose with explicit env file
docker compose --env-file $envFile -f (Join-Path $PSScriptRoot "docker-compose.yaml") up -d --build

if ($LASTEXITCODE -eq 0) {
    Write-Host ""
    Write-Host "Mini Infra development deployment started successfully!" -ForegroundColor Green
    Write-Host ""
    Write-Host "Useful commands:" -ForegroundColor Cyan
    Write-Host "  View logs:    docker compose -f deployment/development/docker-compose.yaml logs -f"
    Write-Host "  Check status: docker compose -f deployment/development/docker-compose.yaml ps"
    Write-Host "  Rebuild:      docker compose -f deployment/development/docker-compose.yaml up -d --build"
    Write-Host "  Stop:         docker compose -f deployment/development/docker-compose.yaml down"
    Write-Host ""
} else {
    Write-Host ""
    Write-Host "ERROR: Failed to start Mini Infra" -ForegroundColor Red
    exit 1
}
