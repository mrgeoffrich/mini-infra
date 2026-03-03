# Mini Infra API Routes

## System

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check |

## Auth (`/auth`)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/auth/google` | Initiate Google OAuth |
| GET | `/auth/google/callback` | OAuth callback |
| GET | `/auth/failure` | OAuth failure page |
| POST | `/auth/logout` | Logout |
| GET | `/auth/status` | Auth status |
| GET | `/auth/user` | Current user profile |

## API Keys (`/api/keys`)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/keys/` | List API keys |
| POST | `/api/keys/` | Create API key |
| PATCH | `/api/keys/:keyId/revoke` | Revoke key |
| POST | `/api/keys/:keyId/rotate` | Rotate key |
| DELETE | `/api/keys/:keyId` | Delete key |
| GET | `/api/keys/stats` | Key usage stats |

## Containers (`/api/containers`)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/containers/` | List containers (filterable, paginated) |
| GET | `/api/containers/postgres` | List PostgreSQL containers |
| GET | `/api/containers/managed-ids` | List managed container IDs |
| GET | `/api/containers/:id` | Get container details |
| GET | `/api/containers/:id/env` | Get container env vars |
| GET | `/api/containers/stats/cache` | Cache statistics |
| POST | `/api/containers/cache/flush` | Flush cache |
| GET | `/api/containers/by-deployment/:deploymentId` | Containers for deployment |
| GET | `/api/containers/:id/logs/stream` | Stream logs (SSE) |
| POST | `/api/containers/:id/:action` | Container action (start/stop/restart/remove) |

## Docker (`/api/docker`)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/docker/networks` | List networks |
| DELETE | `/api/docker/networks/:id` | Remove network |
| GET | `/api/docker/volumes` | List volumes |
| DELETE | `/api/docker/volumes/:name` | Remove volume |
| POST | `/api/docker/volumes/:name/inspect` | Start volume inspection |
| GET | `/api/docker/volumes/:name/inspect` | Get inspection results |
| POST | `/api/docker/volumes/:name/files/fetch` | Batch fetch file contents |
| GET | `/api/docker/volumes/:name/files` | Get single file content |

## Settings (`/api/settings`)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/settings/` | List settings |
| POST | `/api/settings/` | Create setting |
| GET | `/api/settings/docker-host` | Get Docker host IP |
| GET | `/api/settings/connectivity` | Connectivity status logs |
| POST | `/api/settings/validate/:service` | Validate service connectivity |
| GET | `/api/settings/security` | Get security secrets (masked) |
| POST | `/api/settings/security/regenerate` | Regenerate secret |
| GET | `/api/settings/:id` | Get setting by ID |
| PUT | `/api/settings/:id` | Update setting |
| DELETE | `/api/settings/:id` | Delete setting |

## System Settings (`/api/settings/system`)

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/settings/system/test-docker-registry` | Test Docker registry |

## Azure Settings (`/api/settings/azure`)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/settings/azure/` | Get Azure config |
| PUT | `/api/settings/azure/` | Update Azure config |
| POST | `/api/settings/azure/validate` | Validate Azure connection |
| DELETE | `/api/settings/azure/` | Delete Azure config |
| GET | `/api/settings/azure/containers` | List Azure containers |
| POST | `/api/settings/azure/test-container` | Test Azure container |

## Cloudflare Settings (`/api/settings/cloudflare`)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/settings/cloudflare/` | Get Cloudflare config |
| POST | `/api/settings/cloudflare/` | Create/update config |
| PATCH | `/api/settings/cloudflare/` | Partial update config |
| DELETE | `/api/settings/cloudflare/` | Delete config |
| POST | `/api/settings/cloudflare/test` | Test API connectivity |
| GET | `/api/settings/cloudflare/tunnels` | List tunnels |
| GET | `/api/settings/cloudflare/tunnels/:id` | Tunnel details |
| GET | `/api/settings/cloudflare/tunnels/:id/config` | Tunnel configuration |
| POST | `/api/settings/cloudflare/tunnels/:id/hostnames` | Add hostname |
| DELETE | `/api/settings/cloudflare/tunnels/:id/hostnames/:hostname` | Remove hostname |

## GitHub Settings (`/api/settings/github`)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/settings/github/` | Get GitHub config |
| POST | `/api/settings/github/` | Create/update config |
| PATCH | `/api/settings/github/` | Partial update config |
| DELETE | `/api/settings/github/` | Delete config |
| POST | `/api/settings/github/test` | Test API connectivity |

## GitHub Bug Report (`/api/github/bug-report`)

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/github/bug-report/` | Create bug report as GitHub issue |

## Self-Backup Settings (`/api/settings/self-backup`)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/settings/self-backup/` | Get backup settings |
| PUT | `/api/settings/self-backup/` | Update backup settings |
| POST | `/api/settings/self-backup/enable` | Enable self-backup |
| POST | `/api/settings/self-backup/disable` | Disable self-backup |
| POST | `/api/settings/self-backup/trigger` | Trigger manual backup |
| GET | `/api/settings/self-backup/schedule-info` | Get schedule info |

## Self-Backups (`/api/self-backups`)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/self-backups/` | List backups |
| GET | `/api/self-backups/health` | Backup health status |
| GET | `/api/self-backups/:id` | Get backup details |
| GET | `/api/self-backups/:id/download` | Download backup |
| DELETE | `/api/self-backups/:id` | Delete backup |

## Connectivity

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/connectivity/azure/` | Azure connectivity status |
| GET | `/api/connectivity/azure/history` | Azure connectivity history |
| GET | `/api/connectivity/cloudflare` | Cloudflare connectivity status |
| GET | `/api/connectivity/cloudflare/history` | Cloudflare connectivity history |

## PostgreSQL Databases (`/api/postgres/databases`)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/postgres/databases/` | List database configs |
| GET | `/api/postgres/databases/:id` | Get database config |
| POST | `/api/postgres/databases/` | Create database config |
| PUT | `/api/postgres/databases/:id` | Update database config |
| DELETE | `/api/postgres/databases/:id` | Delete database config |
| POST | `/api/postgres/databases/:id/test` | Test connection |
| POST | `/api/postgres/databases/test-connection` | Test connection (no save) |
| POST | `/api/postgres/databases/discover-databases` | Discover databases on server |

## PostgreSQL Backup Configs (`/api/postgres/backup-configs`)

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/postgres/backup-configs/quick-setup` | Quick setup backup |
| GET | `/api/postgres/backup-configs/:databaseId` | Get backup config |
| POST | `/api/postgres/backup-configs/` | Create backup config |
| PUT | `/api/postgres/backup-configs/:id` | Update backup config |
| DELETE | `/api/postgres/backup-configs/:id` | Delete backup config |

## PostgreSQL Backups (`/api/postgres`)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/postgres/backups/:databaseId` | List backups for database |
| POST | `/api/postgres/backups/:databaseId/manual` | Trigger manual backup |
| GET | `/api/postgres/backups/:backupId/status` | Backup status |
| DELETE | `/api/postgres/backups/:backupId` | Delete backup |
| GET | `/api/postgres/backups/:backupId/progress` | Backup progress |

## PostgreSQL Restore (`/api/postgres`)

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/postgres/restore/:databaseId` | Start restore |
| GET | `/api/postgres/restore/:operationId/status` | Restore status |
| GET | `/api/postgres/restore/backups/:containerName` | List available backups |
| GET | `/api/postgres/restore/:databaseId/operations` | Restore operations |
| GET | `/api/postgres/restore/:operationId/progress` | Restore progress |

## PostgreSQL Progress (`/api/postgres/progress`)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/postgres/progress/backup/:operationId` | Backup progress |
| GET | `/api/postgres/progress/restore/:operationId` | Restore progress |
| GET | `/api/postgres/progress/active` | Active operations |
| GET | `/api/postgres/progress/history` | Operation history |
| POST | `/api/postgres/progress/cleanup` | Cleanup old operations |

## PostgreSQL Servers (`/api/postgres-server/servers`)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/postgres-server/servers/` | List servers |
| POST | `/api/postgres-server/servers/` | Create server |
| GET | `/api/postgres-server/servers/:id` | Get server |
| PUT | `/api/postgres-server/servers/:id` | Update server |
| DELETE | `/api/postgres-server/servers/:id` | Delete server |
| POST | `/api/postgres-server/servers/test-connection` | Test connection |
| POST | `/api/postgres-server/servers/:id/test` | Test saved connection |
| GET | `/api/postgres-server/servers/:id/info` | Server info |

### Server Databases (`/api/postgres-server/servers/:serverId/databases`)

| Method | Path | Description |
|--------|------|-------------|
| GET | `.../databases/` | List databases |
| POST | `.../databases/` | Create database |
| GET | `.../databases/:dbId` | Get database |
| DELETE | `.../databases/:dbId` | Delete database |
| PUT | `.../databases/:dbId/owner` | Change owner |
| POST | `.../databases/sync` | Sync databases |
| GET | `.../databases/:dbId/grants` | List database grants |

### Database Tables (`/api/postgres-server/servers/:serverId/databases/:dbId/tables`)

| Method | Path | Description |
|--------|------|-------------|
| GET | `.../tables/` | List tables |
| GET | `.../tables/:tableName/data` | Get table data |

### Server Users (`/api/postgres-server/servers/:serverId/users`)

| Method | Path | Description |
|--------|------|-------------|
| GET | `.../users/` | List users |
| POST | `.../users/` | Create user |
| GET | `.../users/:userId` | Get user |
| PUT | `.../users/:userId` | Update user |
| DELETE | `.../users/:userId` | Delete user |
| POST | `.../users/:userId/password` | Change password |
| POST | `.../users/sync` | Sync users |
| GET | `.../users/:userId/grants` | List user grants |

## PostgreSQL Grants (`/api/postgres-server/grants`)

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/postgres-server/grants/` | Create grant |
| GET | `/api/postgres-server/grants/:grantId` | Get grant |
| PUT | `/api/postgres-server/grants/:grantId` | Update grant |
| DELETE | `/api/postgres-server/grants/:grantId` | Delete grant |

## PostgreSQL Workflows (`/api/postgres-server/workflows`)

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/postgres-server/workflows/create-app-database` | Create app database workflow |

## Deployments (`/api/deployments`)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/deployments/configs` | List deployment configs |
| POST | `/api/deployments/configs` | Create deployment config |
| GET | `/api/deployments/configs/:id` | Get deployment config |
| PUT | `/api/deployments/configs/:id` | Update deployment config |
| DELETE | `/api/deployments/configs/:id` | Delete deployment config |
| POST | `/api/deployments/trigger` | Trigger deployment |
| GET | `/api/deployments/:id/status` | Deployment status |
| POST | `/api/deployments/:id/rollback` | Rollback deployment |
| GET | `/api/deployments/history` | Deployment history |
| POST | `/api/deployments/configs/validate-hostname` | Validate hostname |
| GET | `/api/deployments/:id/containers` | Deployment containers |
| GET | `/api/deployments/removal/:removalId/status` | Removal status |
| DELETE | `/api/deployments/configs/:id/remove-containers` | Remove deployment containers |

## Deployment DNS (`/api/deployments`)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/deployments/configs/:configId/dns` | Get DNS config |
| POST | `/api/deployments/configs/:configId/dns/sync` | Sync DNS |
| DELETE | `/api/deployments/configs/:configId/dns` | Delete DNS config |
| GET | `/api/deployments/dns` | List all DNS configs |

## Deployment Infrastructure (`/api/deployment-infrastructure`)

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/deployment-infrastructure/deploy` | Deploy infrastructure |
| GET | `/api/deployment-infrastructure/status` | Infrastructure status |
| DELETE | `/api/deployment-infrastructure/cleanup` | Cleanup resources |

## HAProxy Frontends (`/api/deployments` and `/api/haproxy/frontends`)

| Method | Path | Description |
|--------|------|-------------|
| GET | `.../` | List frontends |
| POST | `.../shared` | Create shared frontend |
| POST | `.../:frontendName/ssl` | Configure SSL |
| GET | `.../:frontendName` | Get frontend |
| GET | `.../configs/:configId/frontend` | Get frontend for config |
| POST | `.../configs/:configId/frontend/sync` | Sync frontend for config |
| GET | `.../:frontendName/routes` | List routes |
| POST | `.../:frontendName/routes` | Add route |
| PATCH | `.../:frontendName/routes/:routeId` | Update route |
| DELETE | `.../:frontendName/routes/:routeId` | Delete route |

## HAProxy Backends (`/api/haproxy/backends`)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/haproxy/backends` | List backends (filter by `environmentId`, `status`, `sourceType`, `name`) |
| GET | `/api/haproxy/backends/:backendName?environmentId=` | Get backend with servers |
| PATCH | `/api/haproxy/backends/:backendName?environmentId=` | Update backend config (propagates to HAProxy) |
| GET | `/api/haproxy/backends/:backendName/servers?environmentId=` | List servers in backend |
| GET | `/api/haproxy/backends/:backendName/servers/:serverName?environmentId=` | Get server details |
| PATCH | `/api/haproxy/backends/:backendName/servers/:serverName?environmentId=` | Update server (propagates to HAProxy) |

## Manual HAProxy Frontends (`/api/haproxy/manual-frontends`)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/haproxy/manual-frontends/containers` | List available containers |
| POST | `/api/haproxy/manual-frontends/` | Create manual frontend |
| GET | `/api/haproxy/manual-frontends/:frontendName` | Get frontend |
| PUT | `/api/haproxy/manual-frontends/:frontendName` | Update frontend |
| DELETE | `/api/haproxy/manual-frontends/:frontendName` | Delete frontend |

## Environments (`/api/environments`)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/environments/` | List environments |
| POST | `/api/environments/` | Create environment |
| GET | `/api/environments/:id` | Get environment |
| PUT | `/api/environments/:id` | Update environment |
| DELETE | `/api/environments/:id` | Delete environment |
| GET | `/api/environments/:id/status` | Environment status |
| GET | `/api/environments/:id/validate-ports` | Validate ports |
| POST | `/api/environments/:id/start` | Start environment |
| POST | `/api/environments/:id/stop` | Stop environment |
| GET | `/api/environments/:id/services` | List services |
| POST | `/api/environments/:id/services` | Add service |
| GET | `/api/environments/services/available` | Available service types |
| GET | `/api/environments/services/available/:serviceType` | Service type details |
| GET | `/api/environments/:id/networks` | List networks |
| GET | `/api/environments/:id/volumes` | List volumes |
| POST | `/api/environments/:id/remediate-haproxy` | Remediate HAProxy |
| GET | `/api/environments/:id/haproxy-status` | HAProxy status |
| GET | `/api/environments/:id/remediation-preview` | Remediation preview |

## TLS Settings (`/api/tls`)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/tls/settings` | Get TLS settings |
| PUT | `/api/tls/settings` | Update TLS settings |
| POST | `/api/tls/connectivity/test` | Test ACME connectivity |
| GET | `/api/tls/containers` | List TLS-enabled containers |

## TLS Certificates (`/api/tls/certificates`)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/tls/certificates/` | List certificates |
| POST | `/api/tls/certificates/` | Request certificate |
| GET | `/api/tls/certificates/:id` | Get certificate |
| POST | `/api/tls/certificates/:id/renew` | Renew certificate |
| DELETE | `/api/tls/certificates/:id` | Delete certificate |

## TLS Renewals (`/api/tls/renewals`)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/tls/renewals/` | List renewals |
| GET | `/api/tls/renewals/:id` | Get renewal |
| GET | `/api/tls/renewals/certificate/:certificateId` | Renewals for certificate |

## Registry Credentials (`/api/registry-credentials`)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/registry-credentials/` | List credentials |
| GET | `/api/registry-credentials/:id` | Get credential |
| POST | `/api/registry-credentials/` | Create credential |
| PUT | `/api/registry-credentials/:id` | Update credential |
| DELETE | `/api/registry-credentials/:id` | Delete credential |
| POST | `/api/registry-credentials/:id/set-default` | Set as default |
| POST | `/api/registry-credentials/:id/test` | Test saved credential |
| POST | `/api/registry-credentials/test-connection` | Test connection |

## Events (`/api/events`)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/events/` | List events |
| GET | `/api/events/statistics` | Event statistics |
| GET | `/api/events/:id` | Get event |
| POST | `/api/events/` | Create event |
| PATCH | `/api/events/:id` | Update event |
| POST | `/api/events/:id/logs` | Add event log |
| DELETE | `/api/events/:id` | Delete event |

## User Preferences (`/api/user`)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/user/preferences` | Get preferences |
| PUT | `/api/user/preferences` | Update preferences |
| GET | `/api/user/timezones` | List timezones |
