/**
 * Curated API endpoint reference for the AI agent's system prompt.
 * The agent uses this to know which endpoints are available and how to call them.
 * The system prompt template prepends the base URL (e.g., http://localhost:5005).
 */

export const API_REFERENCE = `
## Available API Endpoints

### Health
- GET /health — Server health check

### Containers
- GET /api/containers — List all Docker containers (supports ?all=true for stopped)
- GET /api/containers/:id — Get container details
- POST /api/containers/:id/start — Start a container
- POST /api/containers/:id/stop — Stop a container
- POST /api/containers/:id/restart — Restart a container

### Docker
- GET /api/docker/info — Docker host information
- GET /api/docker/version — Docker version details

### Deployments
- GET /api/deployments — List all deployment configurations
- GET /api/deployments/:id — Get deployment details
- POST /api/deployments/:id/deploy — Trigger a deployment
- GET /api/deployments/:id/status — Get deployment status
- GET /api/deployments/:id/history — Get deployment history

### Environments
- GET /api/environments — List all environments
- GET /api/environments/:id — Get environment details

### HAProxy Load Balancer
- GET /api/haproxy/frontends — List HAProxy frontends
- GET /api/haproxy/backends — List HAProxy backends
- GET /api/haproxy/manual-frontends — List manual HAProxy frontends

### PostgreSQL Databases
- GET /api/postgres/databases — List tracked databases
- GET /api/postgres/backup-configs — List backup configurations
- GET /api/postgres/backups — List backups

### PostgreSQL Servers
- GET /api/postgres-server/servers — List PostgreSQL servers
- GET /api/postgres-server/servers/:id — Get server details

### Connectivity & Health
- GET /api/connectivity/azure — Azure connectivity status
- GET /api/connectivity/cloudflare — Cloudflare connectivity status
- GET /api/settings/connectivity — All connectivity statuses

### Settings
- GET /api/settings — General settings
- GET /api/settings/system — System settings
- GET /api/settings/docker-host — Docker host settings
- GET /api/settings/azure — Azure storage settings
- GET /api/settings/cloudflare — Cloudflare settings

### TLS Certificates
- GET /api/tls/certificates — List TLS certificates
- GET /api/tls/renewals — List certificate renewals
- GET /api/tls/settings — TLS settings

### Events
- GET /api/events — List system events (supports filtering)

### Self Backups
- GET /api/self-backups — List self-backup records
- GET /api/settings/self-backup — Self-backup configuration

### Registry Credentials
- GET /api/registry-credentials — List Docker registry credentials
`;
