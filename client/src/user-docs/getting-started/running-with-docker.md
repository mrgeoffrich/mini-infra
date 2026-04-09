---
title: Running Mini Infra with Docker
description: How to run Mini Infra using Docker or Docker Compose.
tags:
  - getting-started
  - docker
  - installation
  - configuration
---

# Running Mini Infra with Docker

Mini Infra is distributed as a Docker image. The recommended way to run it is with Docker Compose, mounting the Docker socket so it can manage your host's containers.

## Prerequisites

- Docker Engine and Docker Compose installed on the host
- Access to the host's Docker socket (`/var/run/docker.sock`)
- For backups and TLS certificates: an Azure Storage account
- For Cloudflare features: a Cloudflare account and API token
- For Google login (optional): a Google OAuth 2.0 client ID and secret, configured in the Authentication Settings page

## Environment variables

All environment variables are optional. The application auto-generates a secret on first boot if `APP_SECRET` is not set.

| Variable | Description |
|----------|-------------|
| `APP_SECRET` | (Optional) Secret used for JWT signing, API key hashing, and encryption. Auto-generated if not set. |
| `ALLOWED_ADMIN_EMAILS` | (Optional) Comma-separated list of emails allowed to log in. |

## Example docker-compose.yml

```yaml
version: '3.8'

services:
  mini-infra:
    image: ghcr.io/mrgeoffrich/mini-infra:latest
    container_name: mini-infra
    ports:
      - "5000:5000"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - mini-infra-data:/app/data
      - mini-infra-logs:/app/server/logs
    environment:
      - NODE_ENV=production
      - LOG_LEVEL=info
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "node", "-e", "require('http').get('http://localhost:5000/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"]
      interval: 30s
      timeout: 3s
      start_period: 40s
      retries: 3

volumes:
  mini-infra-data:
  mini-infra-logs:
```

## Starting the container

```bash
docker compose up -d
```

Mini Infra will be available at `http://your-host:5000`.

## Volumes

| Volume | Purpose |
|--------|---------|
| `/var/run/docker.sock` | Grants Mini Infra access to the host Docker daemon (required) |
| `/app/data` | Persistent SQLite database and application data |
| `/app/server/logs` | Application log files |

## Health check

The container exposes a `/health` endpoint. Docker's built-in health check polls this endpoint every 30 seconds. The container is marked `healthy` once it responds with HTTP 200.

To check health manually:

```bash
docker exec mini-infra node -e "require('http').get('http://localhost:5000/health', (r) => {r.on('data', d => console.log(d.toString()))})"
```

## Graceful shutdown

Mini Infra handles `SIGTERM` cleanly — it stops background schedulers, flushes logs, and closes the database before exiting. `docker stop` sends `SIGTERM` with a 10-second grace period, which is enough for a clean shutdown.

## After startup

1. Open the application in your browser.
2. Log in with Google.
3. Go to [Connected Services → Docker](/connectivity-docker) and enter your Docker host URL (typically `unix:///var/run/docker.sock`).
4. Optionally configure Azure Storage, Cloudflare, and GitHub under **Connected Services**.

## What to watch out for

- Mounting `/var/run/docker.sock` gives Mini Infra **full control** of the Docker daemon on the host. Only use this in trusted environments.
- The app secret must remain stable. Changing it invalidates all active sessions and breaks all existing API keys. See [Security Settings](/settings-security) for how to rotate it safely.
- The `mini-infra-data` volume contains the SQLite database. Losing it means losing all configuration. Back it up or use the self-backup feature (see [Configuring Backup Schedules](/postgres-backups/configuring-backups)).
