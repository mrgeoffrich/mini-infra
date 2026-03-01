---
title: API Overview
description: An overview of how to use the Mini Infra REST API with API keys.
category: API
order: 1
tags:
  - api
  - authentication
  - api-keys
  - configuration
---

# API Overview

Mini Infra exposes a REST API at `/api/` that gives programmatic access to all features available in the UI. Authenticate with API keys to automate deployments, query container status, trigger backups, and more.

## Authentication

All API requests must include an API key. Use one of these two headers:

```bash
# Option 1 — Authorization header
curl -H "Authorization: Bearer <your-api-key>" http://your-host:5000/api/containers

# Option 2 — x-api-key header
curl -H "x-api-key: <your-api-key>" http://your-host:5000/api/containers
```

Both header formats are equivalent. Choose whichever fits your tooling.

## Getting an API key

Create API keys at [/api-keys/new](/api-keys/new). See [Managing API Keys](/settings/api-keys) for a full guide.

## Permissions

Each API key has a set of permission scopes that control what it can access. Requests for resources outside the key's permissions return `403 Forbidden`.

Example: a key with `containers:read` can `GET /api/containers` but cannot `POST /api/containers/:id/start`.

See [API Key Permission Presets](/settings/permission-presets) for a summary of available scopes.

## Common API endpoints

### Containers

| Method | Endpoint | Permission | Description |
|--------|----------|-----------|-------------|
| GET | `/api/containers` | `containers:read` | List all containers |
| POST | `/api/containers/:id/start` | `containers:write` | Start a container |
| POST | `/api/containers/:id/stop` | `containers:write` | Stop a container |
| POST | `/api/containers/:id/restart` | `containers:write` | Restart a container |

### Deployments

| Method | Endpoint | Permission | Description |
|--------|----------|-----------|-------------|
| GET | `/api/deployments/configs` | `deployments:read` | List deployment configurations |
| POST | `/api/deployments/configs` | `deployments:write` | Create a deployment configuration |
| POST | `/api/deployments/configs/:id/deploy` | `deployments:write` | Trigger a deployment |

### PostgreSQL Backups

| Method | Endpoint | Permission | Description |
|--------|----------|-----------|-------------|
| GET | `/api/postgres/databases` | `postgres:read` | List database configurations |
| POST | `/api/postgres/databases/:id/backup` | `postgres:write` | Trigger a manual backup |

### Settings

| Method | Endpoint | Permission | Description |
|--------|----------|-----------|-------------|
| GET | `/api/settings/system` | `settings:read` | Get system settings |
| PATCH | `/api/settings/system` | `settings:write` | Update system settings |

## Response format

All API responses use a consistent JSON envelope:

```json
{
  "success": true,
  "data": { ... }
}
```

Errors return:

```json
{
  "success": false,
  "error": "Error message here"
}
```

## HTTP status codes

| Code | Meaning |
|------|---------|
| 200 | Success |
| 201 | Resource created |
| 400 | Bad request (validation error) |
| 401 | Missing or invalid API key |
| 403 | Insufficient permissions |
| 404 | Resource not found |
| 409 | Conflict (e.g., duplicate name) |
| 500 | Internal server error |

## Development API key

In development mode, Mini Infra automatically creates a development API key with full access. To display it:

```bash
cd server && npm run show-dev-key
```

This key only works in development mode (`NODE_ENV=development`).

## What to watch out for

- API key values are shown **only once** at creation. Store them securely in a secrets manager or environment variable.
- Rotate API keys regularly for long-lived integrations. See [Managing API Keys](/settings/api-keys) for how to revoke and replace keys.
- The `*` (full access) permission scope bypasses all permission checks. Only grant it to fully trusted automation.
- Rate limiting is not currently enforced, but treat the API as a shared resource — avoid polling endpoints more frequently than necessary.
