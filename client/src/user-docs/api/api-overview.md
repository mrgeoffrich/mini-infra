---
title: API Overview
description: How to authenticate with the Mini Infra API using API keys.
category: API
order: 1
tags:
  - api
  - api-keys
  - authentication
  - rest
  - curl
---

# API Overview

Mini Infra exposes a REST API that powers the web interface. You can use the same API with your own tools and scripts by authenticating with an API key.

## Authentication

All API requests require authentication. There are two ways to include your API key:

**Authorization header:**

```
Authorization: Bearer mk_your_api_key_here
```

**x-api-key header:**

```
x-api-key: mk_your_api_key_here
```

Both methods are equivalent. Use whichever fits your tooling.

## Creating an API key

Navigate to **API Keys** under Administration in the sidebar. Click **Create API Key**, give it a descriptive name, and click create.

The key is displayed once. Copy it immediately — it won't be shown again. API keys are stored as hashes in the database, so Mini Infra can verify them but can't retrieve the original value.

Keys use the format `mk_` followed by 64 hexadecimal characters.

## Managing API keys

The API Keys page shows all keys with their name, prefix (`mk_xxxx...`), status, creation date, and last used timestamp.

Available actions:

- **Rotate** — Generates a new key value. The old key continues to work during a grace period, giving you time to update your scripts.
- **Revoke** — Disables the key so it can no longer authenticate. The key record is preserved for audit purposes.
- **Delete** — Permanently removes the key.

The page also shows summary statistics: total keys, active keys, and when any key was last used.

## Example usage

```bash
# List all containers
curl -H "x-api-key: mk_your_key" http://localhost:5005/api/containers

# List deployment configurations
curl -H "x-api-key: mk_your_key" http://localhost:5005/api/deployments/configs

# Trigger a deployment
curl -X POST \
  -H "x-api-key: mk_your_key" \
  -H "Content-Type: application/json" \
  -d '{"applicationName": "myapp"}' \
  http://localhost:5005/api/deployments/trigger
```

Replace `localhost:5005` with your Mini Infra host and port.

## Development API key

In development mode (`NODE_ENV=development`), Mini Infra automatically creates a development API key at startup. Run this command from the server directory to display it:

```bash
cd server && npm run show-dev-key
```

This key only works in development mode and should not be used in production.

## What to watch out for

- API keys provide the same level of access as a logged-in user. Treat them like passwords.
- Revoked keys cannot be re-enabled. If you revoke a key by accident, create a new one.
- The API follows the same endpoints that the web interface uses. The routes are not separately documented yet, but you can observe them in browser developer tools.
- Rate limiting is not enforced by default, but the server does log all API requests.
