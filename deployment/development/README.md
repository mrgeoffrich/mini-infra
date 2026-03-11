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

## Testing Self-Update Locally

The `test-self-update.sh` script lets you test the self-update sidecar mechanism entirely on your local machine, without pushing to ghcr.io.

### How It Works

The self-update feature uses a sidecar container that swaps the running Mini Infra container with a new image version. Normally it pulls from a remote registry, but for local testing the script:

1. **Automatically** starts a local Docker registry container on port 5051 (no manual setup needed — localhost is exempt from Docker's HTTPS requirement)
2. Builds the main app image and pushes it to the local registry as `localhost:5051/mini-infra:v2-test`
3. Builds the sidecar image and tags it as `localhost:5051/mini-infra-sidecar:v1-test`
4. Configures the running app's self-update settings to point at the local registry
5. Triggers the update via the API and tails the sidecar logs

Everything is handled by the script — you just need a running `mini-infra-dev` container and an API key.

The sidecar then performs the full update flow: pull image, inspect the running container, stop it, start a new container from the pulled image, and health-check it. If the health check fails, it automatically rolls back.

### Prerequisites

- `mini-infra-dev` container running (via `./start.sh`)
- A valid API key with `settings:write` permission (get one from the Mini Infra UI under Settings > API Keys)

### Usage

```bash
# Run the self-update test
./test-self-update.sh <YOUR_API_KEY>

# Clean up test resources afterwards
./test-self-update.sh cleanup
```

The script will prompt for confirmation before triggering the actual update.

### What Happens During the Test

```
trigger → sidecar launches
           → pulls localhost:5051/mini-infra:v2-test from local registry
           → inspects mini-infra-dev to capture env, volumes, ports, networks
           → stops mini-infra-dev, renames it to mini-infra-dev-old-<timestamp>
           → creates new container with captured settings + new image
           → health-checks the new container
           → on success: removes old container, exits 0
           → on failure: rolls back to old container, exits 1
```

### After the Test

After a successful update, the container is **no longer managed by docker-compose** (it was created directly by the sidecar via the Docker API). To restore the original setup:

```bash
# Clean up test resources (registry, images, sidecars)
./test-self-update.sh cleanup

# Remove the replaced container and restart from docker-compose
docker stop mini-infra-dev 2>/dev/null; docker rm mini-infra-dev 2>/dev/null
./start.sh
```

### Checking Results

```bash
# See container status
docker ps -a --filter 'name=mini-infra'

# Query the update result via API
curl -s -H 'x-api-key: <KEY>' http://localhost:3005/api/self-update/status | python3 -m json.tool
```

## When to Use This vs Regular Development

| Scenario | Use This | Use `npm run dev` |
|----------|----------|-------------------|
| Testing Docker builds | ✅ Yes | ❌ No |
| Testing docker-compose | ✅ Yes | ❌ No |
| Rapid code iteration | ❌ No | ✅ Yes |
| Testing in production-like environment | ✅ Yes | ❌ No |
| Debugging with hot reload | ❌ No | ✅ Yes |
