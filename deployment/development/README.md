# Mini Infra - Development Deployment

This folder contains a Docker Compose configuration for **testing the Docker deployment locally** by building from your local codebase.

## Purpose

Use this deployment to:
- Test Docker image builds before pushing to production
- Validate docker-compose configuration changes
- Debug containerized deployment issues
- Test the application in a production-like container environment

## Quick Start

### 1. Create Environment File

Create a `.env` file in this directory:

```bash
SESSION_SECRET=<generate with: openssl rand -base64 32>
API_KEY_SECRET=<generate with: openssl rand -base64 32>
GOOGLE_CLIENT_ID=your_google_client_id
GOOGLE_CLIENT_SECRET=your_google_client_secret
GOOGLE_CALLBACK_URL=http://localhost:5000/auth/google/callback
```

### 2. Run the Startup Script

**Linux/macOS/Git Bash:**
```bash
./start.sh
```

**Windows PowerShell:**
```powershell
./start.ps1
```

The script will:
- Check for the `.env` file
- Build the Docker image from the local Dockerfile
- Start the services with docker-compose

## What's Different from Production?

- **Builds locally** instead of pulling from ghcr.io
- Uses `mini-infra-dev` container name (won't conflict with production)
- Uses separate volumes (`mini-infra-dev-data`, etc.)
- Log level defaults to `debug` for more verbose output
- OpenTelemetry resource attributes set to `development` environment

## Common Commands

```bash
# View logs
docker compose logs -f mini-infra

# Check status
docker compose ps

# Rebuild after code changes
docker compose up -d --build

# Stop services
docker compose down

# Stop and remove volumes (clean slate)
docker compose down -v

# Execute commands in container
docker compose exec mini-infra sh
```

## Notes

- This builds from `../../Dockerfile` (project root)
- The build process includes multi-stage builds for lib, client, and server
- Database migrations run automatically on container startup
- Requires Docker socket access (`/var/run/docker.sock`) for container management features

## When to Use This vs Regular Development

| Scenario | Use This | Use `npm run dev` |
|----------|----------|-------------------|
| Testing Docker builds | ✅ Yes | ❌ No |
| Testing docker-compose | ✅ Yes | ❌ No |
| Rapid code iteration | ❌ No | ✅ Yes |
| Testing in production-like environment | ✅ Yes | ❌ No |
| Debugging with hot reload | ❌ No | ✅ Yes |
