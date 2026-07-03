import type { ContainerQueryParams } from "./containers";

// ====================
// TanStack Query Key Factory
// ====================
//
// The single source of truth for TanStack Query `queryKey` arrays, shared
// between every client hook that reads or invalidates a given resource.
// Mirrors the house idiom in `socket-events.ts` / `api-routes.ts`: `as const`
// value/builder maps grouped by resource, with parameterized builders for
// keys that vary by filter/id.
//
// - Most resource groups start with `all` — the bare, un-parameterized key
//   used for broad invalidation. TanStack's default `invalidateQueries`
//   match is a prefix match, so `invalidateQueries({ queryKey: X.all })`
//   also matches every narrower key built as `[...X.all, ...more]`.
// - A few resources (`stacks`, `applications`, `environments`) predate this
//   factory with call sites that invalidate a *singular* sibling key
//   (`["stack", id]`, `["environment", id]`) that does **not** share a
//   prefix with the plural `all` root (`["stacks"]`, `["environments"]`).
//   Those call sites already invalidate both keys explicitly side by side —
//   this factory reproduces that exact shape rather than "fixing" it, since
//   restructuring would silently break the cross-hook invalidation other
//   files depend on (see `client/src/lib/task-type-registry.ts`, which
//   invalidates several of these bare arrays by hand across resources).
// - Once other call sites depend on a key's shape, never restructure it in
//   place — add a new builder instead.
//
// `containers` is the Phase 3 reference implementation (mirrored by
// `client/src/hooks/useContainers.ts`). Phase 4 grows every other group the
// client calls, following the same shape (root `all` + additive narrower
// builders), preserving the exact array literal every existing call site
// already used so cross-hook invalidation keeps matching.

export const queryKeys = {
  containers: {
    /** Root key for the containers resource — matches every narrower containers key by prefix. */
    all: ["containers"] as const,
    /** List query key — one cache entry per distinct `queryParams` value. */
    list: (params: ContainerQueryParams) => ["containers", params] as const,
    /** PostgreSQL-detected containers (GET /api/containers/postgres). */
    postgres: ["postgres-containers"] as const,
    /** Container-id → PostgresServer-id map (GET /api/containers/managed-ids). */
    managedIds: ["managed-container-ids"] as const,
  },

  agent: {
    all: ["agent"] as const,
    status: ["agent", "status"] as const,
    settings: ["agent", "settings"] as const,
    conversations: (limit?: number) => ["agent-conversations", limit] as const,
    conversation: (id: string) => ["agent-conversations", id] as const,
  },

  agentSidecar: {
    all: ["agent-sidecar"] as const,
    status: ["agent-sidecar", "status"] as const,
    config: ["agent-sidecar", "config"] as const,
  },

  authSettings: {
    all: ["auth-settings"] as const,
  },

  connectivity: {
    status: ["connectivityStatus"] as const,
    cloudflare: ["cloudflare-connectivity"] as const,
  },

  diagnostics: {
    all: ["diagnostics"] as const,
  },

  dns: {
    zones: ["dns-zones"] as const,
    zoneRecords: (zoneId: string) => ["dns-zone-records", zoneId] as const,
    validate: (hostname: string) => ["dns-validate", hostname] as const,
  },

  docker: {
    networks: ["docker-networks"] as const,
    volumes: ["docker-volumes"] as const,
    volumeInspection: (volumeName: string) => ["volume-inspection", volumeName] as const,
    volumeFileContent: (volumeName: string, filePath?: string) =>
      ["volume-file-content", volumeName, filePath] as const,
  },

  egressFwAgent: {
    all: ["egress-fw-agent"] as const,
    status: ["egress-fw-agent", "status"] as const,
    config: ["egress-fw-agent", "config"] as const,
  },

  egress: {
    policies: (query?: unknown) => ["egressPolicies", query] as const,
    policy: (policyId: string) => ["egressPolicy", policyId] as const,
    rules: (policyId: string) => ["egressRules", policyId] as const,
    events: (query?: unknown) => ["egressEvents", query] as const,
  },

  environments: {
    /** Root key for the environments *list* — does not prefix-match `detail()` (see file header). */
    all: ["environments"] as const,
    list: (filters?: unknown) => ["environments", filters] as const,
    /** Singular sibling key used by every existing call site for a single environment. */
    detail: (id: string) => ["environment", id] as const,
    status: (id: string) => ["environmentStatus", id] as const,
    deleteCheck: (id: string) => ["environmentDeleteCheck", id] as const,
    haproxyStatus: (id: string) => ["haproxy-status", id] as const,
    migrationPreview: (id: string) => ["migration-preview", id] as const,
    remediationPreview: (id: string) => ["remediation-preview", id] as const,
  },

  events: {
    all: ["events"] as const,
    detail: (id: string) => ["event", id] as const,
    statistics: ["eventStatistics"] as const,
  },

  githubApp: {
    packages: ["github-app-packages"] as const,
    packageVersions: (packageName: string) =>
      ["github-app-package-versions", packageName] as const,
    repos: ["github-app-repos"] as const,
    repoActionRuns: (owner: string, repo: string) =>
      ["github-app-action-runs", owner, repo] as const,
  },

  githubSettings: {
    all: ["github-settings"] as const,
  },

  githubAppSettings: {
    all: ["github-app-settings"] as const,
  },

  haproxy: {
    frontends: ["haproxy-frontends"] as const,
    frontend: (frontendName: string) => ["haproxy-frontend", frontendName] as const,
    routes: (frontendName: string) => ["haproxy-routes", frontendName] as const,
    backends: ["haproxy-backends"] as const,
    backend: (backendName: string) => ["haproxy-backend", backendName] as const,
    servers: (backendName: string) => ["haproxy-servers", backendName] as const,
  },

  apiKeys: {
    all: ["apiKeys"] as const,
    stats: ["apiKeyStats"] as const,
  },

  loki: {
    logs: (query?: unknown) => ["lokiLogs", query] as const,
    labelValues: (label: string) => ["lokiLabelValues", label] as const,
  },

  monitoring: {
    status: ["monitoringStatus"] as const,
    plan: ["monitoringPlan"] as const,
    prometheusQuery: (query?: unknown) => ["prometheusQuery", query] as const,
    prometheusRangeQuery: (query?: unknown) => ["prometheusRangeQuery", query] as const,
  },

  nats: {
    all: ["nats"] as const,
    status: ["nats", "status"] as const,
    accounts: ["nats", "accounts"] as const,
    credentials: ["nats", "credentials"] as const,
    streams: ["nats", "streams"] as const,
    consumers: ["nats", "consumers"] as const,
    prefixAllowlist: ["nats", "prefix-allowlist"] as const,
  },

  onboarding: {
    setupStatus: ["setup-status"] as const,
  },

  permissionPresets: {
    all: ["permissionPresets"] as const,
  },

  poolInstances: {
    forService: (stackId: string, serviceName: string) =>
      ["pool-instances", stackId, serviceName] as const,
  },

  postgresServer: {
    /** Root key for the postgres-server (managed database server) resource. */
    all: ["postgres-servers"] as const,
    detail: (id: string) => ["postgres-servers", id] as const,
    databasesForServer: (serverId: string) => ["postgres-servers", serverId, "databases"] as const,
    usersForServer: (serverId: string) => ["postgres-servers", serverId, "users"] as const,
    tablesForDatabase: (serverId: string, databaseId: string) =>
      ["postgres-servers", serverId, "databases", databaseId, "tables"] as const,
    tableData: (serverId: string, databaseId: string, tableName: string, query?: unknown) =>
      ["postgres-servers", serverId, "databases", databaseId, "tables", tableName, "data", query] as const,
    /** A single managed database's own detail/grants (not nested under a server). */
    database: (databaseId: string) => ["postgres-databases", databaseId] as const,
    databaseGrants: (databaseId: string) => ["postgres-databases", databaseId, "grants"] as const,
    /** A single managed user's own detail/grants (not nested under a server). */
    user: (userId: string) => ["postgres-users", userId] as const,
    userGrants: (userId: string) => ["postgres-users", userId, "grants"] as const,
    grants: ["postgres-grants"] as const,
    grant: (grantId: string) => ["postgres-grants", grantId] as const,
  },

  /**
   * The separate "backup target database" resource (`/api/postgres/databases`
   * et al) — distinct from `postgresServer` above (`/api/postgres-server/...`)
   * despite the near-identical names. Two different backend resources that
   * happen to read similarly; kept as separate groups rather than merged so
   * neither `.all` root accidentally over-invalidates the other.
   */
  postgresDatabases: {
    all: ["postgresDatabases"] as const,
    list: (
      filters?: unknown,
      page?: number,
      limit?: number,
      sortBy?: string,
      sortOrder?: string,
    ) => ["postgresDatabases", filters, page, limit, sortBy, sortOrder] as const,
    detail: (id: string) => ["postgresDatabase", id] as const,
    /**
     * Pre-existing invalidation target with no matching query anywhere in
     * the app (likely a latent no-op bug predating this migration) —
     * preserved as-is rather than silently repointed. See Phase 4 report.
     */
    managedDatabasesLegacy: ["managedDatabases"] as const,
  },

  postgresBackupConfig: {
    forDatabase: (databaseId: string) => ["postgresBackupConfig", databaseId] as const,
  },

  postgresBackupOperations: {
    all: ["postgresBackupOperations"] as const,
    forDatabase: (databaseId: string) => ["postgresBackupOperations", databaseId] as const,
    status: (backupId: string) => ["postgresBackupOperationStatus", backupId] as const,
    progress: (backupId: string) => ["postgresBackupOperationProgress", backupId] as const,
  },

  postgresRestoreOperations: {
    all: ["postgresRestoreOperations"] as const,
    forDatabase: (databaseId: string) => ["postgresRestoreOperations", databaseId] as const,
    status: (operationId: string) => ["postgresRestoreOperationStatus", operationId] as const,
    progress: (operationId: string) => ["postgresRestoreOperationProgress", operationId] as const,
  },

  postgresProgress: {
    activeOperations: ["postgresActiveOperations"] as const,
    operationHistory: (filters?: unknown) => ["postgresOperationHistory", filters] as const,
    backupProgress: (operationId: string) => ["postgresBackupProgress", operationId] as const,
    restoreProgress: (operationId: string) => ["postgresRestoreProgress", operationId] as const,
  },

  registryCredentials: {
    all: ["registry-credentials"] as const,
  },

  selfBackup: {
    health: ["backup-health"] as const,
    config: ["self-backup-config"] as const,
    scheduleInfo: ["schedule-info"] as const,
  },

  selfUpdate: {
    status: ["self-update-status"] as const,
  },

  settings: {
    all: ["settings"] as const,
    validation: ["settingsValidation"] as const,
    validator: (service: string) => ["settingsValidator", service] as const,
    systemSettings: ["systemSettings"] as const,
    systemSetting: (id: string) => ["systemSetting", id] as const,
    cloudflareSettings: ["cloudflare-settings"] as const,
    cloudflareTunnels: ["cloudflare-tunnels"] as const,
    cloudflareTunnel: (id: string) => ["cloudflare-tunnel", id] as const,
    cloudflareTunnelConfig: (id: string) => ["cloudflare-tunnel-config", id] as const,
    managedTunnels: ["managed-tunnels"] as const,
    managedTunnel: (environmentId: string) => ["managed-tunnel", environmentId] as const,
    tailscaleSettings: ["tailscaleSettings"] as const,
    tlsSettings: ["settings", "tls"] as const,
    storageSettings: ["storage", "settings"] as const,
  },

  stacks: {
    /** Root key for the stack *list* — does not prefix-match the singular keys below (see file header). */
    all: ["stacks"] as const,
    list: (environmentId?: string, scope?: string) =>
      ["stacks", environmentId, scope] as const,
    eligibleContainers: ["eligible-containers"] as const,
    detail: (stackId: string) => ["stack", stackId] as const,
    plan: (stackId: string) => ["stackPlan", stackId] as const,
    status: (stackId: string) => ["stackStatus", stackId] as const,
    history: (stackId: string) => ["stackHistory", stackId] as const,
    validation: (stackId: string) => ["stackValidation", stackId] as const,
    prerequisites: (stackId: string) => ["stackPrerequisites", stackId] as const,
    addonEndpoints: (stackId: string) => ["stack-addon-endpoints", stackId] as const,
  },

  stackTemplates: {
    all: ["stackTemplates"] as const,
    list: (params?: unknown) => ["stackTemplates", params] as const,
    detail: (templateId: string) => ["stackTemplate", templateId] as const,
    versions: (templateId: string) => ["stackTemplateVersions", templateId] as const,
    prerequisites: (templateId: string) => ["templatePrerequisites", templateId] as const,
  },

  applications: {
    all: ["applications"] as const,
    detail: (id: string) => ["application", id] as const,
    userStacks: ["userStacks"] as const,
  },

  tailscaleDevices: {
    all: ["tailscale-devices"] as const,
  },

  tls: {
    certificates: ["certificates"] as const,
    certificate: (id: string) => ["certificates", id] as const,
    renewals: (certificateId?: string) => ["renewals", certificateId] as const,
    settings: ["tls"] as const,
    containers: ["tls-certificates"] as const,
  },

  userPreferences: {
    all: ["userPreferences"] as const,
    timezones: ["timezones"] as const,
  },

  users: {
    all: ["users"] as const,
  },

  vault: {
    /** Root key for the whole vault resource — prefix-matches every narrower vault key below. */
    all: ["vault"] as const,
    status: ["vault", "status"] as const,
    policies: ["vault", "policies"] as const,
    policy: (id: string) => ["vault", "policies", id] as const,
    appRoles: ["vault", "approles"] as const,
    appRole: (id: string) => ["vault", "approles", id] as const,
    appRoleStacks: (id: string) => ["vault", "approles", id, "stacks"] as const,
    operatorCredentials: ["vault", "operator-credentials"] as const,
  },

  auth: {
    status: ["auth", "status"] as const,
  },

  appVersion: {
    all: ["app-version"] as const,
  },

  appHealth: {
    all: ["app-health"] as const,
  },
} as const;
