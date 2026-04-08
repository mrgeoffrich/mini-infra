# Mini Infra Deployment

This directory contains Docker deployment configurations for Mini Infra.

## Structure

- **`production/`** - Production deployment using published Docker images from GitHub Container Registry
- **`development/`** - Development deployment that builds from local Dockerfile for testing

## Quick Start

### Production Deployment

Deploy using pre-built images from ghcr.io:

```bash
# Navigate to production folder
cd deployment/production

# Create your .env file (see DEPLOYMENT.md for details)
# APP_SECRET is auto-generated on first boot if not set

# Run the startup script
./start.sh          # Linux/macOS
./start.ps1         # Windows PowerShell
```

See [production/DEPLOYMENT.md](production/DEPLOYMENT.md) for complete production deployment guide.

### Development Deployment

Test the Docker deployment by building from your local codebase:

```bash
# Navigate to development folder
cd deployment/development

# Create your .env file

# Run the startup script (builds from local Dockerfile)
./start.sh          # Linux/macOS
./start.ps1         # Windows PowerShell
```

## Environment Files

Both production and development require a `.env` file in their respective directories.

**Optional variables:**
- `APP_SECRET` - Application secret for auth and encryption (auto-generated on first boot if not set)
- `ALLOWED_ADMIN_EMAILS` - Comma-separated list of allowed login emails
- `LOG_LEVEL` - Logging level (debug, info, warn, error)

## Differences

| Feature | Production | Development |
|---------|-----------|-------------|
| Image Source | ghcr.io (pre-built) | Local build from Dockerfile |
| Container Name | `mini-infra` | `mini-infra-dev` |
| Volumes | `mini-infra-*` | `mini-infra-dev-*` |
| Log Level | `info` (default) | `debug` (default) |
| Use Case | Production servers | Testing Docker deployment locally |

## Common Commands

After starting with the scripts, you can manage the deployment:

**Production:**
```bash
cd deployment/production

# View logs
docker compose logs -f

# Check status
docker compose ps

# Stop
docker compose down

# Update to latest image
docker compose pull
docker compose up -d
```

**Development:**
```bash
cd deployment/development

# View logs
docker compose logs -f

# Rebuild and restart
docker compose up -d --build

# Stop
docker compose down
```
