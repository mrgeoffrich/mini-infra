import type { ContainerAction } from "./containers";

// ====================
// API Route Registry
// ====================
//
// The single compile-checked source of truth for `/api/...` (and `/auth/...`)
// path strings, shared between client and server. Mirrors the house idiom in
// `socket-events.ts`: `as const` value-maps + `satisfies` guards +
// parameterized builder functions + a flat `ALL_*` array for a CI
// drift-check.
//
// - `ApiBase` — every top-level mount prefix from
//   `server/src/app-factory.ts`'s `getRouteDefinitions()`, keyed by the same
//   `id` used there. The mount table sources its `path` values from here.
// - `ApiRoute` — parameterized path builders grouped by resource. Every
//   client-called endpoint has a builder here (Phase 4); groups are ordered
//   roughly alphabetically. Follow the `containers` shape (Phase 2's
//   reference) when adding a new group: one builder per distinct path
//   *template* (not per HTTP method — GET/PUT/DELETE on the same path share
//   one builder, the caller picks the method via `apiFetch`'s `method`
//   option).
// - `ALL_API_ROUTES` (re-exported from `./api-routes.generated`) — the flat,
//   param-normalized (`:id` style) enumeration of every live route. This is
//   generated (never hand-edited) by `pnpm gen:api-routes`, and is the
//   drift-check's source of truth (see
//   `server/src/__tests__/api-routes-drift.test.ts`).

/**
 * Every top-level mount prefix the server registers, keyed by the same `id`
 * used in `server/src/app-factory.ts`'s `getRouteDefinitions()`. Two ids can
 * share the same literal path (e.g. `cloudflareConnectivity` and
 * `tailscaleConnectivity` both mount at `/api/connectivity`) — that mirrors
 * the live mount table exactly, so don't "dedupe" a value here without
 * removing the corresponding mount.
 */
export const ApiBase = {
  auth: "/auth",
  setupRestore: "/auth/setup/restore",
  users: "/api/users",
  authSettings: "/api/auth-settings",
  apiKeys: "/api/keys",
  containers: "/api/containers",
  docker: "/api/docker",
  selfBackupSettings: "/api/settings/self-backup",
  systemSettings: "/api/settings/system",
  storageGoogleDriveOAuth: "/api/storage/google-drive/oauth",
  storageSettings: "/api/storage",
  cloudflareSettings: "/api/settings/cloudflare",
  tailscaleSettings: "/api/settings/tailscale",
  githubSettings: "/api/settings/github",
  githubAppSettings: "/api/settings/github-app",
  githubAppResources: "/api/github-app",
  githubBugReport: "/api/github/bug-report",
  settingsConnectivity: "/api/settings/connectivity",
  settingsValidation: "/api/settings/validate",
  settingsDocker: "/api/settings/docker-host",
  settings: "/api/settings",
  storageConnectivity: "/api/connectivity/storage",
  cloudflareConnectivity: "/api/connectivity",
  tailscaleConnectivity: "/api/connectivity",
  tailscaleDevices: "/api/tailscale",
  postgresDatabases: "/api/postgres/databases",
  postgresBackupConfigs: "/api/postgres/backup-configs",
  postgresBackups: "/api/postgres",
  postgresRestore: "/api/postgres",
  postgresProgress: "/api/postgres/progress",
  userPreferences: "/api/user",
  haproxyFrontends: "/api/haproxy/frontends",
  manualHaproxyFrontends: "/api/haproxy/manual-frontends",
  haproxyBackends: "/api/haproxy/backends",
  environments: "/api/environments",
  selfBackups: "/api/self-backups",
  registryCredentials: "/api/registry-credentials",
  postgresServer: "/api/postgres-server/servers",
  postgresServerGrants: "/api/postgres-server/grants",
  postgresServerWorkflows: "/api/postgres-server/workflows",
  tlsSettings: "/api/tls",
  tlsCertificates: "/api/tls/certificates",
  tlsRenewals: "/api/tls/renewals",
  events: "/api/events",
  monitoring: "/api/monitoring",
  permissionPresets: "/api/permission-presets",
  egress: "/api/egress",
  egressFwAgent: "/api/egress-fw-agent",
  stacks: "/api/stacks",
  stackTemplates: "/api/stack-templates",
  selfUpdate: "/api/self-update",
  agentSidecar: "/api/agent-sidecar",
  dns: "/api/dns",
  images: "/api/images",
  apiRoutes: "/api/routes",
  openapi: "/api/openapi.json",
  agent: "/api/agent",
  addons: "/api/addons",
  diagnostics: "/api/diagnostics",
  onboarding: "/api/onboarding",
  vaultPolicies: "/api/vault/policies",
  vaultAppRoles: "/api/vault/approles",
  vaultKv: "/api/vault/kv",
  vault: "/api/vault",
  natsPrefixAllowlist: "/api/nats/prefix-allowlist",
  nats: "/api/nats",
  /** Dev-only: only mounted when `ENABLE_DEV_API_KEY_ENDPOINT=true`. */
  devApiKey: "/api/dev",
} as const satisfies Record<string, string>;

/**
 * Parameterized path builders, grouped by resource. `containers` is the
 * Phase 2 reference — every endpoint in `server/src/routes/containers.ts` has
 * a matching builder here, and both that router and
 * `client/src/hooks/useContainers.ts` source their paths from it. Phase 4
 * grows every other group the client calls.
 */
export const ApiRoute = {
  containers: {
    /** GET /api/containers — list (filterable, paginated) */
    list: (): string => `${ApiBase.containers}`,
    /** GET /api/containers/postgres — PostgreSQL-detected containers */
    postgres: (): string => `${ApiBase.containers}/postgres`,
    /** GET /api/containers/managed-ids — container-id → PostgresServer-id map */
    managedIds: (): string => `${ApiBase.containers}/managed-ids`,
    /** GET /api/containers/:id — container details */
    get: (id: string): string => `${ApiBase.containers}/${id}`,
    /** GET /api/containers/:id/env — container environment variables */
    env: (id: string): string => `${ApiBase.containers}/${id}/env`,
    /** GET /api/containers/stats/cache — Docker service cache statistics */
    cacheStats: (): string => `${ApiBase.containers}/stats/cache`,
    /** POST /api/containers/cache/flush — flush the Docker service cache */
    flushCache: (): string => `${ApiBase.containers}/cache/flush`,
    /** GET /api/containers/:id/logs/stream — SSE log stream */
    logsStream: (id: string): string => `${ApiBase.containers}/${id}/logs/stream`,
    /** POST /api/containers/:id/:action — start/stop/restart/remove */
    action: (id: string, action: ContainerAction): string =>
      `${ApiBase.containers}/${id}/${action}`,
  },

  addons: {
    /** GET /api/addons — registry-driven addon catalog (picker + config-form metadata) */
    catalog: (): string => `${ApiBase.addons}`,
  },

  agentSidecar: {
    /** GET/PUT /api/agent-sidecar/config */
    config: (): string => `${ApiBase.agentSidecar}/config`,
    /** POST /api/agent-sidecar/restart */
    restart: (): string => `${ApiBase.agentSidecar}/restart`,
    /** GET /api/agent-sidecar/status */
    status: (): string => `${ApiBase.agentSidecar}/status`,
  },

  agent: {
    /** GET /api/agent/conversations */
    conversations: (): string => `${ApiBase.agent}/conversations`,
    /** GET/DELETE /api/agent/conversations/:id */
    conversation: (id: string): string => `${ApiBase.agent}/conversations/${id}`,
    /** POST /api/agent/sessions */
    sessions: (): string => `${ApiBase.agent}/sessions`,
    /** DELETE /api/agent/sessions/:sessionId */
    session: (sessionId: string): string => `${ApiBase.agent}/sessions/${sessionId}`,
    /** PUT /api/agent/sessions/:sessionId/context */
    sessionContext: (sessionId: string): string =>
      `${ApiBase.agent}/sessions/${sessionId}/context`,
    /** GET /api/agent/sessions/:sessionId/stream — SSE stream */
    sessionStream: (sessionId: string): string =>
      `${ApiBase.agent}/sessions/${sessionId}/stream`,
    /** GET/POST /api/agent/settings */
    settings: (): string => `${ApiBase.agent}/settings`,
    /** DELETE /api/agent/settings/api-key */
    settingsApiKey: (): string => `${ApiBase.agent}/settings/api-key`,
    /** POST /api/agent/settings/validate */
    settingsValidate: (): string => `${ApiBase.agent}/settings/validate`,
    /** GET /api/agent/status */
    status: (): string => `${ApiBase.agent}/status`,
  },

  authSettings: {
    /** GET/PUT /api/auth-settings */
    root: (): string => `${ApiBase.authSettings}`,
  },

  connectivity: {
    /** GET /api/connectivity/cloudflare */
    cloudflare: (): string => `${ApiBase.cloudflareConnectivity}/cloudflare`,
    /** GET /api/connectivity/cloudflare/history */
    cloudflareHistory: (): string => `${ApiBase.cloudflareConnectivity}/cloudflare/history`,
    /** GET /api/connectivity/storage */
    storage: (): string => `${ApiBase.storageConnectivity}`,
    /** GET /api/connectivity/storage/history */
    storageHistory: (): string => `${ApiBase.storageConnectivity}/history`,
    /** GET /api/connectivity/tailscale */
    tailscale: (): string => `${ApiBase.tailscaleConnectivity}/tailscale`,
    /** GET /api/connectivity/tailscale/history */
    tailscaleHistory: (): string => `${ApiBase.tailscaleConnectivity}/tailscale/history`,
    /** GET /api/connectivity/tailscale/ingress */
    tailscaleIngress: (): string => `${ApiBase.tailscaleConnectivity}/tailscale/ingress`,
  },

  diagnostics: {
    /** POST /api/diagnostics/heap-snapshot */
    heapSnapshot: (): string => `${ApiBase.diagnostics}/heap-snapshot`,
    /** GET /api/diagnostics/memory */
    memory: (): string => `${ApiBase.diagnostics}/memory`,
    /** POST /api/diagnostics/region-peek */
    regionPeek: (): string => `${ApiBase.diagnostics}/region-peek`,
    /** GET /api/diagnostics/report */
    report: (): string => `${ApiBase.diagnostics}/report`,
    /** GET /api/diagnostics/smaps-regions */
    smapsRegions: (): string => `${ApiBase.diagnostics}/smaps-regions`,
    /** GET /api/diagnostics/smaps-top */
    smapsTop: (): string => `${ApiBase.diagnostics}/smaps-top`,
  },

  dns: {
    /** POST /api/dns/refresh */
    refresh: (): string => `${ApiBase.dns}/refresh`,
    /** GET /api/dns/validate/:hostname */
    validate: (hostname: string): string => `${ApiBase.dns}/validate/${hostname}`,
    /** GET /api/dns/zones */
    zones: (): string => `${ApiBase.dns}/zones`,
    /** GET /api/dns/zones/:zoneId/records */
    zoneRecords: (zoneId: string): string => `${ApiBase.dns}/zones/${zoneId}/records`,
  },

  docker: {
    /** GET /api/docker/info */
    info: (): string => `${ApiBase.docker}/info`,
    /** GET /api/docker/networks */
    networks: (): string => `${ApiBase.docker}/networks`,
    /** DELETE /api/docker/networks/:id */
    network: (id: string): string => `${ApiBase.docker}/networks/${id}`,
    /** POST /api/docker/networks/:id/connect — attach a container to a network */
    networkConnect: (id: string): string => `${ApiBase.docker}/networks/${id}/connect`,
    /** POST /api/docker/networks/:id/disconnect — detach a container from a network */
    networkDisconnect: (id: string): string => `${ApiBase.docker}/networks/${id}/disconnect`,
    /** GET /api/docker/networks/managed */
    networksManaged: (): string => `${ApiBase.docker}/networks/managed`,
    /** POST /api/docker/networks/gc */
    networksGc: (): string => `${ApiBase.docker}/networks/gc`,
    /** POST /api/docker/networks/backfill-memberships */
    networksBackfillMemberships: (): string => `${ApiBase.docker}/networks/backfill-memberships`,
    /** GET /api/docker/networks/reconcile (report-only diff) / POST (converge) — same path, method distinguishes the two */
    networksReconcile: (): string => `${ApiBase.docker}/networks/reconcile`,
    /** PATCH /api/docker/networks/managed/enforce-memberships */
    networksEnforceMemberships: (): string => `${ApiBase.docker}/networks/managed/enforce-memberships`,
    /** GET /api/docker/volumes */
    volumes: (): string => `${ApiBase.docker}/volumes`,
    /** DELETE /api/docker/volumes/:name */
    volume: (name: string): string => `${ApiBase.docker}/volumes/${name}`,
    /** GET /api/docker/volumes/:name/files */
    volumeFiles: (name: string): string => `${ApiBase.docker}/volumes/${name}/files`,
    /** POST /api/docker/volumes/:name/files/fetch */
    volumeFilesFetch: (name: string): string => `${ApiBase.docker}/volumes/${name}/files/fetch`,
    /** GET/POST /api/docker/volumes/:name/inspect */
    volumeInspect: (name: string): string => `${ApiBase.docker}/volumes/${name}/inspect`,
  },

  egressFwAgent: {
    /** GET/PATCH /api/egress-fw-agent/config */
    config: (): string => `${ApiBase.egressFwAgent}/config`,
    /** POST /api/egress-fw-agent/restart */
    restart: (): string => `${ApiBase.egressFwAgent}/restart`,
    /** POST /api/egress-fw-agent/start */
    start: (): string => `${ApiBase.egressFwAgent}/start`,
    /** GET /api/egress-fw-agent/status */
    status: (): string => `${ApiBase.egressFwAgent}/status`,
  },

  egress: {
    /** GET /api/egress/events */
    events: (): string => `${ApiBase.egress}/events`,
    /** GET /api/egress/policies */
    policies: (): string => `${ApiBase.egress}/policies`,
    /** GET/PATCH /api/egress/policies/:policyId */
    policy: (policyId: string): string => `${ApiBase.egress}/policies/${policyId}`,
    /** GET /api/egress/policies/:policyId/events */
    policyEvents: (policyId: string): string => `${ApiBase.egress}/policies/${policyId}/events`,
    /** GET/POST /api/egress/policies/:policyId/rules */
    policyRules: (policyId: string): string => `${ApiBase.egress}/policies/${policyId}/rules`,
    /** DELETE/PATCH /api/egress/rules/:ruleId */
    rule: (ruleId: string): string => `${ApiBase.egress}/rules/${ruleId}`,
  },

  environments: {
    /** GET/POST /api/environments */
    list: (): string => `${ApiBase.environments}`,
    /** GET/PUT/DELETE /api/environments/:id */
    get: (id: string): string => `${ApiBase.environments}/${id}`,
    /** GET /api/environments/:id/delete-check */
    deleteCheck: (id: string): string => `${ApiBase.environments}/${id}/delete-check`,
    /** GET /api/environments/:id/haproxy-status */
    haproxyStatus: (id: string): string => `${ApiBase.environments}/${id}/haproxy-status`,
    /** POST /api/environments/:id/migrate-haproxy */
    migrateHaproxy: (id: string): string => `${ApiBase.environments}/${id}/migrate-haproxy`,
    /** GET /api/environments/:id/migration-preview */
    migrationPreview: (id: string): string => `${ApiBase.environments}/${id}/migration-preview`,
    /** POST /api/environments/:id/remediate-haproxy */
    remediateHaproxy: (id: string): string => `${ApiBase.environments}/${id}/remediate-haproxy`,
    /** GET /api/environments/:id/remediation-preview */
    remediationPreview: (id: string): string =>
      `${ApiBase.environments}/${id}/remediation-preview`,
  },

  events: {
    /** GET/POST /api/events */
    list: (): string => `${ApiBase.events}`,
    /** GET/PATCH/DELETE /api/events/:id */
    get: (id: string): string => `${ApiBase.events}/${id}`,
    /** POST /api/events/:id/logs */
    logs: (id: string): string => `${ApiBase.events}/${id}/logs`,
    /** GET /api/events/statistics */
    statistics: (): string => `${ApiBase.events}/statistics`,
  },

  githubApp: {
    /** GET /api/github-app/packages */
    packages: (): string => `${ApiBase.githubAppResources}/packages`,
    /** GET /api/github-app/packages/:packageName/versions */
    packageVersions: (packageName: string): string =>
      `${ApiBase.githubAppResources}/packages/${packageName}/versions`,
    /** GET /api/github-app/repos */
    repos: (): string => `${ApiBase.githubAppResources}/repos`,
    /** GET /api/github-app/repos/:owner/:repo/actions/runs */
    repoActionRuns: (owner: string, repo: string): string =>
      `${ApiBase.githubAppResources}/repos/${owner}/${repo}/actions/runs`,
  },

  githubBugReport: {
    /** POST /api/github/bug-report */
    create: (): string => `${ApiBase.githubBugReport}`,
  },

  haproxy: {
    /** GET /api/haproxy/backends */
    backends: (): string => `${ApiBase.haproxyBackends}`,
    /** GET/PATCH/DELETE /api/haproxy/backends/:backendName */
    backend: (backendName: string): string => `${ApiBase.haproxyBackends}/${backendName}`,
    /** GET /api/haproxy/backends/:backendName/servers */
    backendServers: (backendName: string): string =>
      `${ApiBase.haproxyBackends}/${backendName}/servers`,
    /** GET/PATCH/DELETE /api/haproxy/backends/:backendName/servers/:serverName */
    backendServer: (backendName: string, serverName: string): string =>
      `${ApiBase.haproxyBackends}/${backendName}/servers/${serverName}`,
    /** GET /api/haproxy/frontends */
    frontends: (): string => `${ApiBase.haproxyFrontends}`,
    /** POST /api/haproxy/frontends/shared */
    sharedFrontend: (): string => `${ApiBase.haproxyFrontends}/shared`,
    /** GET/DELETE /api/haproxy/frontends/:frontendName */
    frontend: (frontendName: string): string => `${ApiBase.haproxyFrontends}/${frontendName}`,
    /** GET/POST /api/haproxy/frontends/:frontendName/routes */
    frontendRoutes: (frontendName: string): string =>
      `${ApiBase.haproxyFrontends}/${frontendName}/routes`,
    /** PATCH/DELETE /api/haproxy/frontends/:frontendName/routes/:routeId */
    frontendRoute: (frontendName: string, routeId: string): string =>
      `${ApiBase.haproxyFrontends}/${frontendName}/routes/${routeId}`,
    /** POST /api/haproxy/frontends/:frontendName/ssl */
    frontendSsl: (frontendName: string): string =>
      `${ApiBase.haproxyFrontends}/${frontendName}/ssl`,
    /** GET /api/haproxy/manual-frontends/containers */
    manualFrontendContainers: (): string => `${ApiBase.manualHaproxyFrontends}/containers`,
    /** POST /api/haproxy/manual-frontends */
    manualFrontends: (): string => `${ApiBase.manualHaproxyFrontends}`,
    /** GET/PUT/DELETE /api/haproxy/manual-frontends/:frontendName */
    manualFrontend: (frontendName: string): string =>
      `${ApiBase.manualHaproxyFrontends}/${frontendName}`,
  },

  images: {
    /** GET /api/images/inspect-ports */
    inspectPorts: (): string => `${ApiBase.images}/inspect-ports`,
  },

  apiKeys: {
    /** GET/POST /api/keys */
    list: (): string => `${ApiBase.apiKeys}`,
    /** GET /api/keys/permissions */
    permissions: (): string => `${ApiBase.apiKeys}/permissions`,
    /** GET /api/keys/stats */
    stats: (): string => `${ApiBase.apiKeys}/stats`,
    /** DELETE /api/keys/:keyId */
    get: (keyId: string): string => `${ApiBase.apiKeys}/${keyId}`,
    /** PATCH /api/keys/:keyId/revoke */
    revoke: (keyId: string): string => `${ApiBase.apiKeys}/${keyId}/revoke`,
    /** POST /api/keys/:keyId/rotate */
    rotate: (keyId: string): string => `${ApiBase.apiKeys}/${keyId}/rotate`,
  },

  monitoring: {
    /** GET /api/monitoring/loki/label/:name/values */
    lokiLabelValues: (name: string): string => `${ApiBase.monitoring}/loki/label/${name}/values`,
    /** GET /api/monitoring/loki/labels */
    lokiLabels: (): string => `${ApiBase.monitoring}/loki/labels`,
    /** GET /api/monitoring/loki/query */
    lokiQuery: (): string => `${ApiBase.monitoring}/loki/query`,
    /** GET /api/monitoring/loki/query_range */
    lokiQueryRange: (): string => `${ApiBase.monitoring}/loki/query_range`,
    /** GET /api/monitoring/query */
    query: (): string => `${ApiBase.monitoring}/query`,
    /** GET /api/monitoring/query_range */
    queryRange: (): string => `${ApiBase.monitoring}/query_range`,
    /** GET /api/monitoring/status */
    status: (): string => `${ApiBase.monitoring}/status`,
    /** POST /api/monitoring/stop */
    stop: (): string => `${ApiBase.monitoring}/stop`,
    /** GET /api/monitoring/targets */
    targets: (): string => `${ApiBase.monitoring}/targets`,
  },

  nats: {
    /** GET/POST /api/nats/accounts */
    accounts: (): string => `${ApiBase.nats}/accounts`,
    /** PATCH/DELETE /api/nats/accounts/:id */
    account: (id: string): string => `${ApiBase.nats}/accounts/${id}`,
    /** POST /api/nats/apply */
    apply: (): string => `${ApiBase.nats}/apply`,
    /** GET/POST /api/nats/consumers */
    consumers: (): string => `${ApiBase.nats}/consumers`,
    /** PATCH/DELETE /api/nats/consumers/:id */
    consumer: (id: string): string => `${ApiBase.nats}/consumers/${id}`,
    /** GET/POST /api/nats/credentials */
    credentials: (): string => `${ApiBase.nats}/credentials`,
    /** PATCH/DELETE /api/nats/credentials/:id */
    credential: (id: string): string => `${ApiBase.nats}/credentials/${id}`,
    /** POST /api/nats/credentials/:id/mint */
    credentialMint: (id: string): string => `${ApiBase.nats}/credentials/${id}/mint`,
    /** GET/POST /api/nats/prefix-allowlist */
    prefixAllowlist: (): string => `${ApiBase.natsPrefixAllowlist}`,
    /** GET/PUT/DELETE /api/nats/prefix-allowlist/:prefix */
    prefixAllowlistEntry: (prefix: string): string => `${ApiBase.natsPrefixAllowlist}/${prefix}`,
    /** GET /api/nats/status */
    status: (): string => `${ApiBase.nats}/status`,
    /** GET/POST /api/nats/streams */
    streams: (): string => `${ApiBase.nats}/streams`,
    /** PATCH/DELETE /api/nats/streams/:id */
    stream: (id: string): string => `${ApiBase.nats}/streams/${id}`,
  },

  onboarding: {
    /** POST /api/onboarding/complete */
    complete: (): string => `${ApiBase.onboarding}/complete`,
  },

  permissionPresets: {
    /** GET/POST /api/permission-presets */
    list: (): string => `${ApiBase.permissionPresets}`,
    /** PATCH/DELETE /api/permission-presets/:id */
    get: (id: string): string => `${ApiBase.permissionPresets}/${id}`,
  },

  postgresServer: {
    /** POST /api/postgres-server/grants */
    grants: (): string => `${ApiBase.postgresServerGrants}`,
    /** GET/PUT/DELETE /api/postgres-server/grants/:grantId */
    grant: (grantId: string): string => `${ApiBase.postgresServerGrants}/${grantId}`,
    /** GET/POST /api/postgres-server/servers */
    servers: (): string => `${ApiBase.postgresServer}`,
    /** POST /api/postgres-server/servers/test-connection */
    testConnection: (): string => `${ApiBase.postgresServer}/test-connection`,
    /** GET/PUT/DELETE /api/postgres-server/servers/:id */
    server: (id: string): string => `${ApiBase.postgresServer}/${id}`,
    /** GET /api/postgres-server/servers/:id/info */
    serverInfo: (id: string): string => `${ApiBase.postgresServer}/${id}/info`,
    /** POST /api/postgres-server/servers/:id/sync */
    serverSync: (id: string): string => `${ApiBase.postgresServer}/${id}/sync`,
    /** POST /api/postgres-server/servers/:id/test */
    serverTest: (id: string): string => `${ApiBase.postgresServer}/${id}/test`,
    /** GET/POST /api/postgres-server/servers/:serverId/databases */
    databases: (serverId: string): string => `${ApiBase.postgresServer}/${serverId}/databases`,
    /** POST /api/postgres-server/servers/:serverId/databases/sync */
    databasesSync: (serverId: string): string =>
      `${ApiBase.postgresServer}/${serverId}/databases/sync`,
    /** GET/DELETE /api/postgres-server/servers/:serverId/databases/:dbId */
    database: (serverId: string, dbId: string): string =>
      `${ApiBase.postgresServer}/${serverId}/databases/${dbId}`,
    /** GET /api/postgres-server/servers/:serverId/databases/:dbId/grants */
    databaseGrants: (serverId: string, dbId: string): string =>
      `${ApiBase.postgresServer}/${serverId}/databases/${dbId}/grants`,
    /** PUT /api/postgres-server/servers/:serverId/databases/:dbId/owner */
    databaseOwner: (serverId: string, dbId: string): string =>
      `${ApiBase.postgresServer}/${serverId}/databases/${dbId}/owner`,
    /** GET /api/postgres-server/servers/:serverId/databases/:dbId/tables */
    databaseTables: (serverId: string, dbId: string): string =>
      `${ApiBase.postgresServer}/${serverId}/databases/${dbId}/tables`,
    /** GET /api/postgres-server/servers/:serverId/databases/:dbId/tables/:tableName/data */
    databaseTableData: (serverId: string, dbId: string, tableName: string): string =>
      `${ApiBase.postgresServer}/${serverId}/databases/${dbId}/tables/${tableName}/data`,
    /** GET/POST /api/postgres-server/servers/:serverId/users */
    users: (serverId: string): string => `${ApiBase.postgresServer}/${serverId}/users`,
    /** POST /api/postgres-server/servers/:serverId/users/sync */
    usersSync: (serverId: string): string => `${ApiBase.postgresServer}/${serverId}/users/sync`,
    /** GET/PUT/DELETE /api/postgres-server/servers/:serverId/users/:userId */
    user: (serverId: string, userId: string): string =>
      `${ApiBase.postgresServer}/${serverId}/users/${userId}`,
    /** GET /api/postgres-server/servers/:serverId/users/:userId/grants */
    userGrants: (serverId: string, userId: string): string =>
      `${ApiBase.postgresServer}/${serverId}/users/${userId}/grants`,
    /** POST /api/postgres-server/servers/:serverId/users/:userId/password */
    userPassword: (serverId: string, userId: string): string =>
      `${ApiBase.postgresServer}/${serverId}/users/${userId}/password`,
    /** POST /api/postgres-server/workflows/create-app-database */
    createAppDatabase: (): string => `${ApiBase.postgresServerWorkflows}/create-app-database`,
  },

  postgres: {
    /** POST /api/postgres/backup-configs */
    backupConfigs: (): string => `${ApiBase.postgresBackupConfigs}`,
    /** POST /api/postgres/backup-configs/quick-setup */
    backupConfigsQuickSetup: (): string => `${ApiBase.postgresBackupConfigs}/quick-setup`,
    /** GET /api/postgres/backup-configs/:databaseId */
    backupConfigForDatabase: (databaseId: string): string =>
      `${ApiBase.postgresBackupConfigs}/${databaseId}`,
    /** PUT/DELETE /api/postgres/backup-configs/:id */
    backupConfig: (id: string): string => `${ApiBase.postgresBackupConfigs}/${id}`,
    /** GET /api/postgres/backups/:databaseId */
    backupsForDatabase: (databaseId: string): string =>
      `${ApiBase.postgresBackups}/backups/${databaseId}`,
    /** POST /api/postgres/backups/:databaseId/manual */
    manualBackup: (databaseId: string): string =>
      `${ApiBase.postgresBackups}/backups/${databaseId}/manual`,
    /** DELETE /api/postgres/backups/:backupId */
    backup: (backupId: string): string => `${ApiBase.postgresBackups}/backups/${backupId}`,
    /** GET /api/postgres/backups/:backupId/progress */
    backupProgress: (backupId: string): string =>
      `${ApiBase.postgresBackups}/backups/${backupId}/progress`,
    /** GET /api/postgres/backups/:backupId/status */
    backupStatus: (backupId: string): string =>
      `${ApiBase.postgresBackups}/backups/${backupId}/status`,
    /** GET/POST /api/postgres/databases */
    databases: (): string => `${ApiBase.postgresDatabases}`,
    /** POST /api/postgres/databases/discover-databases */
    discoverDatabases: (): string => `${ApiBase.postgresDatabases}/discover-databases`,
    /** POST /api/postgres/databases/test-connection */
    testConnection: (): string => `${ApiBase.postgresDatabases}/test-connection`,
    /** GET/PUT/DELETE /api/postgres/databases/:id */
    database: (id: string): string => `${ApiBase.postgresDatabases}/${id}`,
    /** POST /api/postgres/databases/:id/test */
    databaseTest: (id: string): string => `${ApiBase.postgresDatabases}/${id}/test`,
    /** GET /api/postgres/progress/active */
    progressActive: (): string => `${ApiBase.postgresProgress}/active`,
    /** GET /api/postgres/progress/backup/:operationId */
    progressBackup: (operationId: string): string =>
      `${ApiBase.postgresProgress}/backup/${operationId}`,
    /** POST /api/postgres/progress/cleanup */
    progressCleanup: (): string => `${ApiBase.postgresProgress}/cleanup`,
    /** GET /api/postgres/progress/history */
    progressHistory: (): string => `${ApiBase.postgresProgress}/history`,
    /** GET /api/postgres/progress/restore/:operationId */
    progressRestore: (operationId: string): string =>
      `${ApiBase.postgresProgress}/restore/${operationId}`,
    /** POST /api/postgres/restore/:databaseId */
    restore: (databaseId: string): string => `${ApiBase.postgresRestore}/restore/${databaseId}`,
    /** GET /api/postgres/restore/:databaseId/operations */
    restoreOperations: (databaseId: string): string =>
      `${ApiBase.postgresRestore}/restore/${databaseId}/operations`,
    /** GET /api/postgres/restore/:operationId/progress */
    restoreProgress: (operationId: string): string =>
      `${ApiBase.postgresRestore}/restore/${operationId}/progress`,
    /** GET /api/postgres/restore/:operationId/status */
    restoreStatus: (operationId: string): string =>
      `${ApiBase.postgresRestore}/restore/${operationId}/status`,
    /** GET /api/postgres/restore/backups/:containerName */
    restoreBackupsForContainer: (containerName: string): string =>
      `${ApiBase.postgresRestore}/restore/backups/${containerName}`,
  },

  registryCredentials: {
    /** GET/POST /api/registry-credentials */
    list: (): string => `${ApiBase.registryCredentials}`,
    /** POST /api/registry-credentials/test-connection */
    testConnection: (): string => `${ApiBase.registryCredentials}/test-connection`,
    /** GET/PUT/DELETE /api/registry-credentials/:id */
    get: (id: string): string => `${ApiBase.registryCredentials}/${id}`,
    /** POST /api/registry-credentials/:id/set-default */
    setDefault: (id: string): string => `${ApiBase.registryCredentials}/${id}/set-default`,
    /** POST /api/registry-credentials/:id/test */
    test: (id: string): string => `${ApiBase.registryCredentials}/${id}/test`,
  },

  selfBackups: {
    /** GET /api/self-backups */
    list: (): string => `${ApiBase.selfBackups}`,
    /** GET /api/self-backups/health */
    health: (): string => `${ApiBase.selfBackups}/health`,
    /** GET/DELETE /api/self-backups/:id */
    get: (id: string): string => `${ApiBase.selfBackups}/${id}`,
    /** GET /api/self-backups/:id/download */
    download: (id: string): string => `${ApiBase.selfBackups}/${id}/download`,
  },

  selfUpdate: {
    /** POST /api/self-update/check */
    check: (): string => `${ApiBase.selfUpdate}/check`,
    /** GET /api/self-update/status */
    status: (): string => `${ApiBase.selfUpdate}/status`,
    /** POST /api/self-update/trigger */
    trigger: (): string => `${ApiBase.selfUpdate}/trigger`,
  },

  settings: {
    /** GET/POST /api/settings */
    list: (): string => `${ApiBase.settings}`,
    /** GET/PUT/DELETE /api/settings/:id */
    get: (id: string): string => `${ApiBase.settings}/${id}`,
    /** POST /api/settings/validate/:service */
    validate: (service: string): string => `${ApiBase.settingsValidation}/${service}`,
    /** GET /api/settings/connectivity */
    connectivity: (): string => `${ApiBase.settingsConnectivity}`,
    /** GET /api/settings/connectivity/summary */
    connectivitySummary: (): string => `${ApiBase.settingsConnectivity}/summary`,
    /** GET /api/settings/docker-host */
    dockerHost: (): string => `${ApiBase.settingsDocker}`,
    /** POST /api/settings/system/test-docker-registry */
    systemTestDockerRegistry: (): string => `${ApiBase.systemSettings}/test-docker-registry`,

    /** GET/POST/PATCH/DELETE /api/settings/cloudflare */
    cloudflare: (): string => `${ApiBase.cloudflareSettings}`,
    /** POST /api/settings/cloudflare/test */
    cloudflareTest: (): string => `${ApiBase.cloudflareSettings}/test`,
    /** GET /api/settings/cloudflare/managed-tunnels */
    cloudflareManagedTunnels: (): string => `${ApiBase.cloudflareSettings}/managed-tunnels`,
    /** GET/POST/DELETE /api/settings/cloudflare/managed-tunnels/:environmentId */
    cloudflareManagedTunnel: (environmentId: string): string =>
      `${ApiBase.cloudflareSettings}/managed-tunnels/${environmentId}`,
    /** GET /api/settings/cloudflare/tunnels */
    cloudflareTunnels: (): string => `${ApiBase.cloudflareSettings}/tunnels`,
    /** GET /api/settings/cloudflare/tunnels/:id */
    cloudflareTunnel: (id: string): string => `${ApiBase.cloudflareSettings}/tunnels/${id}`,
    /** GET /api/settings/cloudflare/tunnels/:id/config */
    cloudflareTunnelConfig: (id: string): string =>
      `${ApiBase.cloudflareSettings}/tunnels/${id}/config`,
    /** POST /api/settings/cloudflare/tunnels/:id/hostnames */
    cloudflareTunnelHostnames: (id: string): string =>
      `${ApiBase.cloudflareSettings}/tunnels/${id}/hostnames`,
    /** DELETE /api/settings/cloudflare/tunnels/:id/hostnames/:hostname */
    cloudflareTunnelHostname: (id: string, hostname: string): string =>
      `${ApiBase.cloudflareSettings}/tunnels/${id}/hostnames/${hostname}`,

    /** GET/POST/PATCH/DELETE /api/settings/github */
    github: (): string => `${ApiBase.githubSettings}`,
    /** POST /api/settings/github/test */
    githubTest: (): string => `${ApiBase.githubSettings}/test`,

    /** GET/DELETE /api/settings/github-app */
    githubApp: (): string => `${ApiBase.githubAppSettings}`,
    /** POST /api/settings/github-app/agent/revoke */
    githubAppAgentRevoke: (): string => `${ApiBase.githubAppSettings}/agent/revoke`,
    /** POST /api/settings/github-app/agent/token */
    githubAppAgentToken: (): string => `${ApiBase.githubAppSettings}/agent/token`,
    /** POST /api/settings/github-app/manifest */
    githubAppManifest: (): string => `${ApiBase.githubAppSettings}/manifest`,
    /** GET /api/settings/github-app/oauth/authorize */
    githubAppOauthAuthorize: (): string => `${ApiBase.githubAppSettings}/oauth/authorize`,
    /** POST /api/settings/github-app/oauth/callback */
    githubAppOauthCallback: (): string => `${ApiBase.githubAppSettings}/oauth/callback`,
    /** POST /api/settings/github-app/oauth/pat */
    githubAppOauthPat: (): string => `${ApiBase.githubAppSettings}/oauth/pat`,
    /** POST /api/settings/github-app/oauth/revoke */
    githubAppOauthRevoke: (): string => `${ApiBase.githubAppSettings}/oauth/revoke`,
    /** POST /api/settings/github-app/oauth/sync-registry */
    githubAppOauthSyncRegistry: (): string => `${ApiBase.githubAppSettings}/oauth/sync-registry`,
    /** POST /api/settings/github-app/refresh-installation */
    githubAppRefreshInstallation: (): string =>
      `${ApiBase.githubAppSettings}/refresh-installation`,
    /** POST /api/settings/github-app/setup/complete */
    githubAppSetupComplete: (): string => `${ApiBase.githubAppSettings}/setup/complete`,
    /** POST /api/settings/github-app/test */
    githubAppTest: (): string => `${ApiBase.githubAppSettings}/test`,

    /** GET/PUT /api/settings/self-backup */
    selfBackup: (): string => `${ApiBase.selfBackupSettings}`,
    /** POST /api/settings/self-backup/disable */
    selfBackupDisable: (): string => `${ApiBase.selfBackupSettings}/disable`,
    /** POST /api/settings/self-backup/enable */
    selfBackupEnable: (): string => `${ApiBase.selfBackupSettings}/enable`,
    /** GET /api/settings/self-backup/schedule-info */
    selfBackupScheduleInfo: (): string => `${ApiBase.selfBackupSettings}/schedule-info`,
    /** POST /api/settings/self-backup/trigger */
    selfBackupTrigger: (): string => `${ApiBase.selfBackupSettings}/trigger`,

    /** GET/POST/DELETE /api/settings/tailscale */
    tailscale: (): string => `${ApiBase.tailscaleSettings}`,
    /** GET /api/settings/tailscale/acl-snippet */
    tailscaleAclSnippet: (): string => `${ApiBase.tailscaleSettings}/acl-snippet`,
    /** POST /api/settings/tailscale/probe-tag-ownership */
    tailscaleProbeTagOwnership: (): string => `${ApiBase.tailscaleSettings}/probe-tag-ownership`,
    /** POST /api/settings/tailscale/test */
    tailscaleTest: (): string => `${ApiBase.tailscaleSettings}/test`,
  },

  stackTemplates: {
    /** GET/POST /api/stack-templates */
    list: (): string => `${ApiBase.stackTemplates}`,
    /** GET/PATCH/DELETE /api/stack-templates/:templateId */
    get: (templateId: string): string => `${ApiBase.stackTemplates}/${templateId}`,
    /** POST/DELETE /api/stack-templates/:templateId/draft */
    draft: (templateId: string): string => `${ApiBase.stackTemplates}/${templateId}/draft`,
    /** POST /api/stack-templates/:templateId/instantiate */
    instantiate: (templateId: string): string =>
      `${ApiBase.stackTemplates}/${templateId}/instantiate`,
    /** GET /api/stack-templates/:templateId/prerequisites */
    prerequisites: (templateId: string): string =>
      `${ApiBase.stackTemplates}/${templateId}/prerequisites`,
    /** POST /api/stack-templates/:templateId/publish */
    publish: (templateId: string): string => `${ApiBase.stackTemplates}/${templateId}/publish`,
    /** GET /api/stack-templates/:templateId/versions */
    versions: (templateId: string): string => `${ApiBase.stackTemplates}/${templateId}/versions`,
    /** GET /api/stack-templates/:templateId/versions/:versionId */
    version: (templateId: string, versionId: string): string =>
      `${ApiBase.stackTemplates}/${templateId}/versions/${versionId}`,
    /** GET /api/stack-templates/:templateId/versions/:versionId/export — serialize a version to a portable YAML document */
    exportVersion: (templateId: string, versionId: string): string =>
      `${ApiBase.stackTemplates}/${templateId}/versions/${versionId}/export`,
    /** POST /api/stack-templates/import — create a user template from an exported YAML document */
    import: (): string => `${ApiBase.stackTemplates}/import`,
    /** POST /api/stack-templates/:templateId/rollback — re-point currentVersion to an older published version */
    rollback: (templateId: string): string =>
      `${ApiBase.stackTemplates}/${templateId}/rollback`,
    /** POST /api/stack-templates/:templateId/versions/:versionId/archive — retire (or restore) an old published version */
    archiveVersion: (templateId: string, versionId: string): string =>
      `${ApiBase.stackTemplates}/${templateId}/versions/${versionId}/archive`,
    /** GET /api/stack-templates/predicates — predicate names a `requires` block may use */
    predicates: (): string => `${ApiBase.stackTemplates}/predicates`,
  },

  stacks: {
    /** GET/POST /api/stacks */
    list: (): string => `${ApiBase.stacks}`,
    /** GET /api/stacks/eligible-containers */
    eligibleContainers: (): string => `${ApiBase.stacks}/eligible-containers`,
    /** GET/PUT/DELETE /api/stacks/:stackId */
    get: (stackId: string): string => `${ApiBase.stacks}/${stackId}`,
    /** GET /api/stacks/:stackId/addon-endpoints */
    addonEndpoints: (stackId: string): string => `${ApiBase.stacks}/${stackId}/addon-endpoints`,
    /** POST /api/stacks/:stackId/apply */
    apply: (stackId: string): string => `${ApiBase.stacks}/${stackId}/apply`,
    /** POST /api/stacks/:stackId/destroy */
    destroy: (stackId: string): string => `${ApiBase.stacks}/${stackId}/destroy`,
    /** GET /api/stacks/:stackId/history */
    history: (stackId: string): string => `${ApiBase.stacks}/${stackId}/history`,
    /** GET /api/stacks/:stackId/history/:deploymentId */
    historyEntry: (stackId: string, deploymentId: string): string =>
      `${ApiBase.stacks}/${stackId}/history/${deploymentId}`,
    /** POST /api/stacks/:stackId/history/:deploymentId/restore — restore the definition this deployment applied */
    historyRestore: (stackId: string, deploymentId: string): string =>
      `${ApiBase.stacks}/${stackId}/history/${deploymentId}/restore`,
    /** POST /api/stacks/:stackId/job-pools/:serviceName/run */
    jobPoolRun: (stackId: string, serviceName: string): string =>
      `${ApiBase.stacks}/${stackId}/job-pools/${serviceName}/run`,
    /** GET /api/stacks/:stackId/plan */
    plan: (stackId: string): string => `${ApiBase.stacks}/${stackId}/plan`,
    /** GET/POST /api/stacks/:stackId/pools/:serviceName/instances */
    poolInstances: (stackId: string, serviceName: string): string =>
      `${ApiBase.stacks}/${stackId}/pools/${serviceName}/instances`,
    /** GET/DELETE /api/stacks/:stackId/pools/:serviceName/instances/:instanceId */
    poolInstance: (stackId: string, serviceName: string, instanceId: string): string =>
      `${ApiBase.stacks}/${stackId}/pools/${serviceName}/instances/${instanceId}`,
    /** POST /api/stacks/:stackId/pools/:serviceName/instances/:instanceId/heartbeat */
    poolInstanceHeartbeat: (stackId: string, serviceName: string, instanceId: string): string =>
      `${ApiBase.stacks}/${stackId}/pools/${serviceName}/instances/${instanceId}/heartbeat`,
    /** GET /api/stacks/:stackId/prerequisites */
    prerequisites: (stackId: string): string => `${ApiBase.stacks}/${stackId}/prerequisites`,
    /** PUT /api/stacks/:stackId/services/:serviceName */
    service: (stackId: string, serviceName: string): string =>
      `${ApiBase.stacks}/${stackId}/services/${serviceName}`,
    /** GET/PUT/DELETE /api/stacks/:stackId/services/:serviceName/git-deploy-key */
    serviceGitDeployKey: (stackId: string, serviceName: string): string =>
      `${ApiBase.stacks}/${stackId}/services/${serviceName}/git-deploy-key`,
    /** GET /api/stacks/:stackId/status */
    status: (stackId: string): string => `${ApiBase.stacks}/${stackId}/status`,
    /** POST /api/stacks/:stackId/stop — stop containers, keep the stack definition */
    stop: (stackId: string): string => `${ApiBase.stacks}/${stackId}/stop`,
    /** POST /api/stacks/:stackId/update */
    update: (stackId: string): string => `${ApiBase.stacks}/${stackId}/update`,
    /** POST /api/stacks/:stackId/upgrade — re-materialize from a published template version (body `targetVersionId` picks one; defaults to current) */
    upgrade: (stackId: string): string => `${ApiBase.stacks}/${stackId}/upgrade`,
    /** GET /api/stacks/:stackId/upgrade-inputs — rotateOnUpgrade inputs required to upgrade. Optional `?targetVersionId=` selects the version to read them from (defaults to the template's current). */
    upgradeInputs: (stackId: string): string => `${ApiBase.stacks}/${stackId}/upgrade-inputs`,
    /** POST /api/stacks/:stackId/revert-pending — restore definition from last applied snapshot */
    revertPending: (stackId: string): string => `${ApiBase.stacks}/${stackId}/revert-pending`,
    /** GET /api/stacks/:stackId/validate */
    validate: (stackId: string): string => `${ApiBase.stacks}/${stackId}/validate`,
  },

  storage: {
    /** GET /api/storage */
    root: (): string => `${ApiBase.storageSettings}`,
    /** PUT /api/storage/active-provider */
    activeProvider: (): string => `${ApiBase.storageSettings}/active-provider`,
    /** GET /api/storage/switch-precheck */
    switchPrecheck: (): string => `${ApiBase.storageSettings}/switch-precheck`,
    /** POST /api/storage/:provider/forget */
    forget: (provider: string): string => `${ApiBase.storageSettings}/${provider}/forget`,
    /** GET/PUT/DELETE /api/storage/azure */
    azure: (): string => `${ApiBase.storageSettings}/azure`,
    /** GET /api/storage/azure/locations */
    azureLocations: (): string => `${ApiBase.storageSettings}/azure/locations`,
    /** POST /api/storage/azure/test-location */
    azureTestLocation: (): string => `${ApiBase.storageSettings}/azure/test-location`,
    /** POST /api/storage/azure/validate */
    azureValidate: (): string => `${ApiBase.storageSettings}/azure/validate`,
    /** GET/PUT/DELETE /api/storage/google-drive */
    googleDrive: (): string => `${ApiBase.storageSettings}/google-drive`,
    /** POST /api/storage/google-drive/create-folder */
    googleDriveCreateFolder: (): string => `${ApiBase.storageSettings}/google-drive/create-folder`,
    /** POST /api/storage/google-drive/disconnect */
    googleDriveDisconnect: (): string => `${ApiBase.storageSettings}/google-drive/disconnect`,
    /** GET /api/storage/google-drive/locations */
    googleDriveLocations: (): string => `${ApiBase.storageSettings}/google-drive/locations`,
    /** GET /api/storage/google-drive/oauth/callback */
    googleDriveOauthCallback: (): string => `${ApiBase.storageGoogleDriveOAuth}/callback`,
    /** GET /api/storage/google-drive/oauth/start */
    googleDriveOauthStart: (): string => `${ApiBase.storageGoogleDriveOAuth}/start`,
    /** POST /api/storage/google-drive/test-location */
    googleDriveTestLocation: (): string => `${ApiBase.storageSettings}/google-drive/test-location`,
    /** POST /api/storage/google-drive/validate */
    googleDriveValidate: (): string => `${ApiBase.storageSettings}/google-drive/validate`,
    /** GET/PUT /api/storage/locations/:slot */
    location: (slot: string): string => `${ApiBase.storageSettings}/locations/${slot}`,
  },

  tailscaleDevices: {
    /** GET /api/tailscale/devices */
    list: (): string => `${ApiBase.tailscaleDevices}/devices`,
  },

  tls: {
    /** GET/POST /api/tls/certificates */
    certificates: (): string => `${ApiBase.tlsCertificates}`,
    /** GET/DELETE /api/tls/certificates/:id */
    certificate: (id: string): string => `${ApiBase.tlsCertificates}/${id}`,
    /** POST /api/tls/certificates/:id/renew */
    certificateRenew: (id: string): string => `${ApiBase.tlsCertificates}/${id}/renew`,
    /** POST /api/tls/connectivity/test */
    connectivityTest: (): string => `${ApiBase.tlsSettings}/connectivity/test`,
    /** GET /api/tls/containers */
    containers: (): string => `${ApiBase.tlsSettings}/containers`,
    /** GET /api/tls/renewals */
    renewals: (): string => `${ApiBase.tlsRenewals}`,
    /** GET /api/tls/renewals/:id */
    renewal: (id: string): string => `${ApiBase.tlsRenewals}/${id}`,
    /** GET /api/tls/renewals/certificate/:certificateId */
    renewalsForCertificate: (certificateId: string): string =>
      `${ApiBase.tlsRenewals}/certificate/${certificateId}`,
    /** GET/PUT /api/tls/settings */
    settings: (): string => `${ApiBase.tlsSettings}/settings`,
  },

  userPreferences: {
    /** GET/PUT /api/user/preferences */
    preferences: (): string => `${ApiBase.userPreferences}/preferences`,
    /** GET /api/user/timezones */
    timezones: (): string => `${ApiBase.userPreferences}/timezones`,
  },

  users: {
    /** GET/POST /api/users */
    list: (): string => `${ApiBase.users}`,
    /** DELETE /api/users/:id */
    get: (id: string): string => `${ApiBase.users}/${id}`,
    /** POST /api/users/:id/reset-password */
    resetPassword: (id: string): string => `${ApiBase.users}/${id}/reset-password`,
  },

  vault: {
    /** POST /api/vault/admin/reauthenticate */
    adminReauthenticate: (): string => `${ApiBase.vault}/admin/reauthenticate`,
    /** GET/POST /api/vault/approles */
    appRoles: (): string => `${ApiBase.vaultAppRoles}`,
    /** GET/PUT/DELETE /api/vault/approles/:id */
    appRole: (id: string): string => `${ApiBase.vaultAppRoles}/${id}`,
    /** POST /api/vault/approles/:id/apply */
    appRoleApply: (id: string): string => `${ApiBase.vaultAppRoles}/${id}/apply`,
    /** GET /api/vault/approles/:id/stacks */
    appRoleStacks: (id: string): string => `${ApiBase.vaultAppRoles}/${id}/stacks`,
    /** POST /api/vault/bootstrap */
    bootstrap: (): string => `${ApiBase.vault}/bootstrap`,
    /** GET /api/vault/operator-credentials */
    operatorCredentials: (): string => `${ApiBase.vault}/operator-credentials`,
    /** POST /api/vault/passphrase/lock */
    passphraseLock: (): string => `${ApiBase.vault}/passphrase/lock`,
    /** POST /api/vault/passphrase/unlock */
    passphraseUnlock: (): string => `${ApiBase.vault}/passphrase/unlock`,
    /** GET/POST /api/vault/policies */
    policies: (): string => `${ApiBase.vaultPolicies}`,
    /** GET/PUT/DELETE /api/vault/policies/:id */
    policy: (id: string): string => `${ApiBase.vaultPolicies}/${id}`,
    /** POST /api/vault/policies/:id/publish */
    policyPublish: (id: string): string => `${ApiBase.vaultPolicies}/${id}/publish`,
    /** GET /api/vault/status */
    status: (): string => `${ApiBase.vault}/status`,
    /** POST /api/vault/unseal */
    unseal: (): string => `${ApiBase.vault}/unseal`,
  },

  auth: {
    /** POST /auth/change-password */
    changePassword: (): string => `${ApiBase.auth}/change-password`,
    /** GET /auth/google */
    google: (): string => `${ApiBase.auth}/google`,
    /** POST /auth/login */
    login: (): string => `${ApiBase.auth}/login`,
    /** POST /auth/logout */
    logout: (): string => `${ApiBase.auth}/logout`,
    /** POST /auth/recover/request */
    recoverRequest: (): string => `${ApiBase.auth}/recover/request`,
    /** POST /auth/recover/reset */
    recoverReset: (): string => `${ApiBase.auth}/recover/reset`,
    /** POST /auth/setup */
    setup: (): string => `${ApiBase.auth}/setup`,
    /** GET /auth/setup-status */
    setupStatus: (): string => `${ApiBase.auth}/setup-status`,
    /** POST /auth/setup/complete */
    setupComplete: (): string => `${ApiBase.auth}/setup/complete`,
    /** POST /auth/setup/detect-docker */
    setupDetectDocker: (): string => `${ApiBase.auth}/setup/detect-docker`,
    /** GET /auth/status */
    status: (): string => `${ApiBase.auth}/status`,
    /** GET /auth/user */
    user: (): string => `${ApiBase.auth}/user`,
  },

  /**
   * Public, setup-scoped "Load from Backup" restore flow. Every route is
   * gated server-side on "setup in progress" (no users yet + setup not
   * complete), so these run before an admin account exists.
   */
  setupRestore: {
    /** GET /auth/setup/restore/status */
    status: (): string => `${ApiBase.setupRestore}/status`,
    /** POST /auth/setup/restore/azure/credentials */
    azureCredentials: (): string => `${ApiBase.setupRestore}/azure/credentials`,
    /** GET /auth/setup/restore/azure/locations */
    azureLocations: (): string => `${ApiBase.setupRestore}/azure/locations`,
    /** POST /auth/setup/restore/google-drive/credentials */
    googleDriveCredentials: (): string =>
      `${ApiBase.setupRestore}/google-drive/credentials`,
    /** GET /auth/setup/restore/google-drive/oauth/start */
    googleDriveOauthStart: (): string =>
      `${ApiBase.setupRestore}/google-drive/oauth/start`,
    /** GET /auth/setup/restore/google-drive/locations */
    googleDriveLocations: (): string =>
      `${ApiBase.setupRestore}/google-drive/locations`,
    /** POST /auth/setup/restore/backups */
    backups: (): string => `${ApiBase.setupRestore}/backups`,
    /** POST /auth/setup/restore/execute */
    execute: (): string => `${ApiBase.setupRestore}/execute`,
  },

  /** GET /health — unversioned health check, mounted outside /api */
  health: (): string => "/health",
} as const;

export { ALL_API_ROUTES, type ApiRouteEntry } from "./api-routes.generated";
