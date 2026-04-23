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

Ensure a `.env` file exists at `server/.env` (the start script reads it from there).

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
1. Check for the `.env` file
2. Start a **local Docker registry** on port 5051 (used by both the main app and the agent sidecar)
3. Build the **agent sidecar** image and push it to the local registry
4. Build the **main app** image (with the registry-prefixed sidecar tag baked in) and start all services

## Architecture

The development deployment runs three containers:

| Container | Purpose | Port |
|---|---|---|
| `mini-infra-dev-registry` | Local Docker registry for sidecar images | 5051 |
| `mini-infra-dev` | Main Mini Infra application | 3005 (mapped to 5000 internal) |
| `mini-infra-agent-sidecar` | AI agent sidecar (spawned by mini-infra-dev at startup) | 3100 (internal only) |

The local registry solves the problem of the main app needing to `docker pull` the agent sidecar image at runtime. In production, images come from ghcr.io; in development, the local registry serves the same purpose for locally-built images.

## What's Different from Production?

- **Builds locally** instead of pulling from ghcr.io
- **Local Docker registry** on port 5051 for sidecar images
- Uses `mini-infra-dev` container name (won't conflict with production)
- Uses separate volumes (`mini-infra-dev-data`, `mini-infra-dev-logs`, `mini-infra-dev-registry`)
- Log level defaults to `debug` for more verbose output

## Common Commands

All compose commands should include the compose file path when run from the project root:

```bash
# View logs
docker compose -f deployment/development/docker-compose.yaml logs -f

# Check status
docker compose -f deployment/development/docker-compose.yaml ps

# Full rebuild and restart (recommended — rebuilds sidecar + main app)
./deployment/development/start.sh

# Stop services
docker compose -f deployment/development/docker-compose.yaml down

# Stop and remove volumes (clean slate)
docker compose -f deployment/development/docker-compose.yaml down -v

# Execute commands in container
docker exec -it mini-infra-dev sh

# Seed container database from local dev.db
./deployment/development/start.sh --seed-db
```

## Notes

- This builds from `../../Dockerfile` (project root)
- The build process includes multi-stage builds for lib, client, and server
- Database migrations run automatically on container startup
- Requires Docker socket access (`/var/run/docker.sock`) for container management features
- The agent sidecar image tag (`localhost:5051/mini-infra-agent-sidecar:latest`) is baked into the main image at build time via the `AGENT_SIDECAR_IMAGE_TAG` build arg

## Testing Self-Update Locally

The `test-self-update.sh` script lets you test the self-update sidecar mechanism entirely on your local machine, without pushing to ghcr.io.

### How It Works

The self-update feature uses a sidecar container that swaps the running Mini Infra container with a new image version. Normally it pulls from a remote registry, but for local testing the script reuses the local registry (started by `start.sh`) to:

1. Build the main app image and push it to the local registry as `localhost:5051/mini-infra:v2-test`
2. Build the update sidecar image and tag it as `localhost:5051/mini-infra-sidecar:v1-test`
3. Configure the running app's self-update settings to point at the local registry
4. Trigger the update via the API and tail the sidecar logs

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

# Query the update result via API — resolve the URL from the generated
# environment-details.xml rather than hardcoding the port.
MINI_INFRA_URL=$(xmllint --xpath 'string(//environment/endpoints/ui)' environment-details.xml)
curl -s -H 'x-api-key: <KEY>' "$MINI_INFRA_URL/api/self-update/status" | python3 -m json.tool
```

## When to Use This vs Regular Development

| Scenario | Use This | Use `npm run dev` |
|----------|----------|-------------------|
| Testing Docker builds | ✅ Yes | ❌ No |
| Testing docker-compose | ✅ Yes | ❌ No |
| Testing agent sidecar | ✅ Yes | ❌ No |
| Rapid code iteration | ❌ No | ✅ Yes |
| Testing in production-like environment | ✅ Yes | ❌ No |
| Debugging with hot reload | ❌ No | ✅ Yes |
