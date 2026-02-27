---
title: Running with Docker
description: How to run Mini Infra as a Docker container, including all environment variables and an example docker-compose file.
category: Getting Started
order: 2
tags:
  - docker
  - deployment
  - getting-started
  - configuration
---

# Running with Docker

Mini Infra is distributed as a Docker image. This page covers how to run it, what environment variables to configure, and how to persist data between restarts.

## Quick start

Pull the image from GitHub Container Registry and run it with the minimum required configuration:

```bash
docker run -d \
  --name mini-infra \
  -p 5000:5000 \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v mini-infra-data:/app/data \
  -e SESSION_SECRET=your-random-secret-here \
  -e API_KEY_SECRET=your-api-key-secret-here \
  -e GOOGLE_CLIENT_ID=your-google-oauth-client-id \
  -e GOOGLE_CLIENT_SECRET=your-google-oauth-client-secret \
  ghcr.io/mrgeoffrich/mini-infra:latest
```

The app will be available at `http://localhost:5000`.

## Volumes

Mini Infra needs two volume mounts:

| Mount | Purpose |
|-------|---------|
| `/var/run/docker.sock` | Gives Mini Infra access to the host Docker daemon. This is how it lists, starts, stops, and inspects containers. |
| `/app/data` | The SQLite database file (`production.db`) lives here. Mount a named volume or host directory so your data survives container restarts. |

An optional third volume for logs:

| Mount | Purpose |
|-------|---------|
| `/app/server/logs` | Application log files. Useful if you want to access logs from outside the container or persist them independently. |

## Environment variables

### Required

These must be set for the application to start and function properly.

| Variable | Description |
|----------|-------------|
| `SESSION_SECRET` | A random string used to sign session cookies. Generate one with `openssl rand -hex 32`. If this changes, all existing sessions are invalidated and users must log in again. |
| `API_KEY_SECRET` | A random string used to hash API keys. Generate one with `openssl rand -hex 32`. If this changes, all existing API keys stop working and must be regenerated. |
| `GOOGLE_CLIENT_ID` | OAuth 2.0 client ID from the Google Cloud Console. Required for user authentication. |
| `GOOGLE_CLIENT_SECRET` | OAuth 2.0 client secret from the Google Cloud Console. |

### Recommended

Not strictly required, but you should set these in production.

| Variable | Default | Description |
|----------|---------|-------------|
| `PUBLIC_URL` | — | The full URL users access Mini Infra from (e.g. `https://infra.example.com`). Used for OAuth callback URLs and CORS configuration. When this starts with `http://`, HTTPS-enforcing security headers are automatically disabled. |
| `ENCRYPTION_SECRET` | — | A random string used to encrypt stored PostgreSQL credentials. Without this, you cannot save database connection credentials for backups. Generate one with `openssl rand -hex 32`. |
| `LOG_LEVEL` | `info` | Controls logging verbosity. Options: `trace`, `debug`, `info`, `warn`, `error`, `fatal`, `silent`. |

### Optional tuning

These have sensible defaults and rarely need changing.

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `5000` | The port the application listens on inside the container. Change this if you need a different internal port (you still control the external port via Docker's `-p` flag). |
| `NODE_ENV` | `production` | Set automatically in the Docker image. Do not change this unless you know what you're doing. |
| `CONTAINER_CACHE_TTL` | `3000` | How long (in milliseconds) Docker container data is cached before re-fetching. |
| `CONTAINER_POLL_INTERVAL` | `5000` | How often (in milliseconds) the app polls Docker for container status updates. |
| `AZURE_API_TIMEOUT` | `15000` | Timeout (in milliseconds) for Azure Blob Storage API calls. |
| `CONNECTIVITY_CHECK_INTERVAL` | `300000` | How often (in milliseconds) external service health checks run. Default is 5 minutes. |
| `ALLOW_INSECURE` | `false` | Disables HTTPS-enforcing headers (HSTS, CSP upgrade-insecure-requests). Auto-set to `true` when `PUBLIC_URL` starts with `http://`. Only use this behind a trusted reverse proxy. |

### AI Assistant (optional)

| Variable | Description |
|----------|-------------|
| `ANTHROPIC_API_KEY` | API key from [Anthropic](https://console.anthropic.com/). When set, enables the AI assistant chat feature that can answer questions about your infrastructure and call the Mini Infra API on your behalf. |

### Observability (optional)

These enable log forwarding to OpenObserve and distributed tracing via OpenTelemetry. Leave them unset if you don't use these services.

| Variable | Description |
|----------|-------------|
| `OPENOBSERVE_URL` | Base URL of your OpenObserve instance. |
| `OPENOBSERVE_ORGANIZATION_NAME` | OpenObserve organisation name. |
| `OPENOBSERVE_USERNAME` | OpenObserve authentication username. |
| `OPENOBSERVE_PASSWORD` | OpenObserve authentication password. |
| `OPENOBSERVE_STREAM_NAME` | Log stream name (default: `mini-infra-logs`). |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | OTLP endpoint URL. Tracing is enabled when this is set. |
| `OTEL_EXPORTER_OTLP_HEADERS` | Headers for OTLP authentication (e.g. `Authorization=Basic <base64>`). |
| `OTEL_SERVICE_NAME` | Service name for traces (default: `mini-infra`). |
| `OTEL_SERVICE_VERSION` | Service version for traces (default: `0.1.0`). |
| `OTEL_RESOURCE_ATTRIBUTES` | Additional OTLP resource attributes as comma-separated key=value pairs. |
| `OTEL_SAMPLING_RATIO` | Trace sampling ratio from `0.0` to `1.0` (default: `1.0` — all traces). |
| `OTEL_DEBUG` | Set to `true` to log span data to the console for debugging. |

## Example docker-compose.yml

```yaml
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
      - SESSION_SECRET=${SESSION_SECRET}
      - API_KEY_SECRET=${API_KEY_SECRET}
      - ENCRYPTION_SECRET=${ENCRYPTION_SECRET}
      - GOOGLE_CLIENT_ID=${GOOGLE_CLIENT_ID}
      - GOOGLE_CLIENT_SECRET=${GOOGLE_CLIENT_SECRET}
      - PUBLIC_URL=${PUBLIC_URL}
      - LOG_LEVEL=info
      # Optional: enable AI assistant
      # - ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}
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

Create a `.env` file alongside the compose file with your secrets:

```
SESSION_SECRET=your-random-session-secret
API_KEY_SECRET=your-random-api-key-secret
ENCRYPTION_SECRET=your-random-encryption-secret
GOOGLE_CLIENT_ID=your-google-client-id
GOOGLE_CLIENT_SECRET=your-google-client-secret
PUBLIC_URL=https://infra.example.com
# Optional: AI assistant
# ANTHROPIC_API_KEY=sk-ant-...
```

Then start it:

```bash
docker compose up -d
```

## What happens on first start

When the container starts for the first time, the entrypoint script:

1. Creates the `/app/data` directory if it doesn't exist.
2. Runs Prisma database migrations to set up the SQLite schema.
3. Starts the Node.js application.

On subsequent starts, it applies any pending migrations (for version upgrades) and then starts the app. The database file is created at `/app/data/production.db`.

## Docker socket security

Mini Infra requires access to the host Docker socket to manage containers. This means the application has full control over Docker on the host — it can start, stop, and remove any container.

Only run Mini Infra in environments where you trust the users who have access to it. The Docker socket mount is equivalent to root access on the host.

## Graceful shutdown

The container handles `SIGTERM` properly. When you run `docker stop`, Mini Infra:

- Stops background schedulers and cron jobs
- Closes database connections
- Shuts down OpenTelemetry exporters

Docker's default 10-second stop timeout is sufficient for a clean shutdown.

## What to watch out for

- If `SESSION_SECRET` or `API_KEY_SECRET` is missing, the app will start but authentication or API keys will not work correctly. Always set both.
- Changing `API_KEY_SECRET` after creating API keys invalidates all existing keys. Users will need to generate new ones.
- The `ENCRYPTION_SECRET` is needed before you configure any PostgreSQL server connections. If you add it later, previously stored credentials are not retroactively encrypted.
- The container runs as a non-root `node` user. If your volume mount has restrictive permissions, the container may fail to write the database file. Ensure the mount is writable by UID 1000.
