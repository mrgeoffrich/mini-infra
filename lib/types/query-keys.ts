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
    tailscaleIngress: ["tailscale-ingress-status"] as const,
  },

  diagnostics: {
    all: ["diagnostics"] as const,
    memory: ["diagnostics", "memory"] as const,
    smapsTop: ["diagnostics", "smaps-top"] as const,
    smapsRegions: (pathname: string) => ["diagnostics", "smaps-regions", pathname] as const,
  },

  dns: {
    zones: ["dns-zones"] as const,
    /** Bare root for the zone-records family — broad-invalidates every `zoneRecords(zoneId)` regardless of which zone, used by `useRefreshDnsCache`. */
    zoneRecordsAll: ["dns-zone-records"] as const,
    zoneRecords: (zoneId: string) => ["dns-zone-records", zoneId] as const,
    validate: (hostname: string) => ["dns-validate", hostname] as const,
  },

  docker: {
    networks: ["docker-networks"] as const,
    volumes: ["docker-volumes"] as const,
    volumeInspection: (volumeName: string) => ["volume-inspection", volumeName] as const,
    volumeFileContent: (volumeName: string, filePath?: string) =>
      ["volume-file-content", volumeName, filePath] as const,
    /** Network overhaul Phase 9 — bare root broad-invalidates every `managedNetworks(filter)` variant regardless of scope/owner filter. */
    managedNetworksAll: ["managed-networks"] as const,
    managedNetworks: (filter?: { scope?: string; environmentId?: string; stackId?: string }) =>
      ["managed-networks", filter ?? {}] as const,
    networkReconcile: (scope: string, id?: string) => ["network-reconcile", scope, id] as const,
  },

  egressFwAgent: {
    all: ["egress-fw-agent"] as const,
    status: ["egress-fw-agent", "status"] as const,
    config: ["egress-fw-agent", "config"] as const,
  },

  egress: {
    /** Bare root for the policies list — broad-invalidates every `policies(query)` variant regardless of filters (no shared prefix with `policy()`/`rules()` singular keys — mirrors the stacks/environments split noted in the file header). */
    policiesAll: ["egressPolicies"] as const,
    policies: (query?: unknown) => ["egressPolicies", query] as const,
    policy: (policyId: string) => ["egressPolicy", policyId] as const,
    rules: (policyId: string) => ["egressRules", policyId] as const,
    /** Bare root for the events list/live-feed — broad-invalidates every `events(query)` variant regardless of filters. */
    eventsAll: ["egressEvents"] as const,
    events: (query?: unknown) => ["egressEvents", query] as const,
    /** Per-policy "last 7 days" fetch used only by EgressPromoteWizard — deliberately distinct shape from `events()` (adds a "wizard" marker segment) since it isn't a generic events-list query. */
    eventsWizard: (policyId: string) => ["egressEvents", "wizard", policyId] as const,
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
    /**
     * GET /api/haproxy/frontends — root key for the frontends list. Cross-
     * referenced by `client/src/lib/task-type-registry.ts` and
     * `client/src/hooks/use-connect-container.ts` — keep this literal
     * exactly as-is.
     */
    frontends: ["haproxy-frontends"] as const,
    /**
     * Detail key for a single frontend (GET/DELETE
     * /api/haproxy/frontends/:name). Different string root than `frontends`
     * above (singular vs plural — mirrors the stacks/stack split noted in
     * the file header) — matches every existing call site.
     */
    frontend: (frontendName: string) => ["haproxy-frontend", frontendName] as const,
    /** Bare root for the singular frontend-detail family — broad-invalidates every `frontend(name)` key by prefix. */
    frontendAll: ["haproxy-frontend"] as const,
    /** Routes for a single shared frontend (GET/POST /api/haproxy/frontends/:name/routes). */
    routes: (frontendName: string) => ["haproxy-routes", frontendName] as const,
    /**
     * GET /api/haproxy/backends — root key for the backends list. Cross-
     * referenced by `client/src/lib/task-type-registry.ts` and
     * `client/src/hooks/use-connect-container.ts` — keep this literal
     * exactly as-is.
     */
    backends: ["haproxy-backends"] as const,
    /** Detail key for a single backend, scoped by environment (GET/PATCH /api/haproxy/backends/:name?environmentId=...). */
    backend: (backendName: string, environmentId: string) =>
      ["haproxy-backend", backendName, environmentId] as const,
    /** Bare root for the singular backend-detail family. */
    backendAll: ["haproxy-backend"] as const,
    /** Servers for a single backend, scoped by environment (GET /api/haproxy/backends/:name/servers?environmentId=...). */
    servers: (backendName: string, environmentId: string) =>
      ["haproxy-servers", backendName, environmentId] as const,
    /** Bare root for the backend-servers family. */
    serversAll: ["haproxy-servers"] as const,
    /**
     * Eligible containers for a manual HAProxy frontend (GET
     * /api/haproxy/manual-frontends/containers). Deliberately NOT
     * `["eligible-containers", environmentId]` — that exact literal is
     * already used by `client/src/hooks/use-eligible-containers.ts` for the
     * unrelated `/api/stacks/eligible-containers` resource; reusing it here
     * would silently share a cache entry between two different endpoints.
     */
    manualFrontendEligibleContainers: (environmentId: string) =>
      ["haproxy-manual-frontend-eligible-containers", environmentId] as const,
    /**
     * TLS certificates available for a manual HAProxy frontend's SSL config
     * (GET /api/tls/certificates?environmentId=...&status=ACTIVE). Kept
     * under `haproxy` (rather than the `tls` group) since it's only
     * consumed by the HAProxy manual-frontend flow; preserves the exact
     * prior literal.
     */
    tlsCertificates: (environmentId: string) => ["tls-certificates", environmentId] as const,
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
  },

  postgresBackupConfig: {
    forDatabase: (databaseId: string) => ["postgresBackupConfig", databaseId] as const,
  },

  postgresBackupOperations: {
    all: ["postgresBackupOperations"] as const,
    forDatabase: (databaseId: string) => ["postgresBackupOperations", databaseId] as const,
    /** Paginated/filtered list query key — narrower than `forDatabase`, still matched by it as a prefix. */
    list: (
      databaseId: string,
      filters?: unknown,
      page?: number,
      limit?: number,
      sortBy?: unknown,
      sortOrder?: string,
    ) =>
      ["postgresBackupOperations", databaseId, filters, page, limit, sortBy, sortOrder] as const,
    status: (backupId: string) => ["postgresBackupOperationStatus", backupId] as const,
    progress: (backupId: string) => ["postgresBackupOperationProgress", backupId] as const,
  },

  postgresRestoreOperations: {
    all: ["postgresRestoreOperations"] as const,
    forDatabase: (databaseId: string) => ["postgresRestoreOperations", databaseId] as const,
    /** Paginated/filtered list query key — narrower than `forDatabase`, still matched by it as a prefix. */
    list: (
      databaseId: string,
      filters?: unknown,
      page?: number,
      limit?: number,
      sortBy?: unknown,
      sortOrder?: string,
    ) =>
      ["postgresRestoreOperations", databaseId, filters, page, limit, sortBy, sortOrder] as const,
    status: (operationId: string) => ["postgresRestoreOperationStatus", operationId] as const,
    progress: (operationId: string) => ["postgresRestoreOperationProgress", operationId] as const,
    /** Backup-browser query key for `useAvailableBackups` (browsing backups for a restore). */
    availableBackups: (
      containerName: string,
      databaseId: string,
      filters?: unknown,
      page?: number,
      limit?: number,
      sortBy?: string,
      sortOrder?: string,
    ) =>
      ["availableBackups", containerName, databaseId, filters, page, limit, sortBy, sortOrder] as const,
  },

  postgresProgress: {
    activeOperations: ["postgresActiveOperations"] as const,
    /** Bare root for the operation-history resource — used for broad invalidation (see file header). */
    operationHistoryAll: ["postgresOperationHistory"] as const,
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
    /** Bare root for the backup-history resource — broad-invalidates every `history(...)` variant regardless of filters. */
    historyAll: ["backup-history"] as const,
    /** Paginated/filtered backup-history list query key (positional params mirror the server's query-string filters). */
    history: (
      status?: string,
      triggeredBy?: string,
      startDate?: string,
      endDate?: string,
      sortBy?: string,
      sortOrder?: string,
      page?: number,
      limit?: number,
    ) =>
      ["backup-history", status, triggeredBy, startDate, endDate, sortBy, sortOrder, page, limit] as const,
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
    /** Bare root for the managed-tunnel-detail family — broad-invalidates every `managedTunnel(environmentId)` key by prefix. */
    managedTunnelAll: ["managed-tunnel"] as const,
    managedTunnel: (environmentId: string) => ["managed-tunnel", environmentId] as const,
    tailscaleSettings: ["tailscaleSettings"] as const,
    tlsSettings: ["settings", "tls"] as const,
    storageSettings: ["storage", "settings"] as const,
  },

  /**
   * Storage provider settings (`/api/storage/...`). Bare `all` root
   * prefix-matches every narrower key below (`["storage", ...]`), used
   * throughout `use-storage-settings.ts` and the provider config components
   * for broad invalidation after any provider mutation.
   */
  storage: {
    all: ["storage"] as const,
    switchPrecheck: (targetProvider: string | null) =>
      ["storage", "switch-precheck", targetProvider] as const,
    azureConfig: ["storage", "azure", "config"] as const,
    azureLocations: ["storage", "azure", "locations"] as const,
    locations: (provider: string) => ["storage", provider, "locations"] as const,
    /** Bare root for the whole google-drive sub-tree — prefix-matches `googleDriveConfig`/`googleDriveFolders` below. */
    googleDriveAll: ["storage", "google-drive"] as const,
    googleDriveConfig: ["storage", "google-drive", "config"] as const,
    googleDriveFolders: ["storage", "google-drive", "folders"] as const,
    connectivity: ["storage", "connectivity"] as const,
    connectivityHistory: (
      filters?: unknown,
      page?: number,
      limit?: number,
      sortBy?: string,
      sortOrder?: string,
    ) =>
      ["storage", "connectivity", "history", filters, page, limit, sortBy, sortOrder] as const,
  },

  stacks: {
    /** Root key for the stack *list* — does not prefix-match the singular keys below (see file header). */
    all: ["stacks"] as const,
    list: (environmentId?: string, scope?: string) =>
      ["stacks", environmentId, scope] as const,
    /** Parameterized by `environmentId` to avoid cross-environment cache collisions (GET /api/stacks/eligible-containers?environmentId=...). */
    eligibleContainers: (environmentId?: string) =>
      ["eligible-containers", environmentId] as const,
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
    prerequisites: (templateId: string, environmentId?: string | null) =>
      ["templatePrerequisites", templateId, environmentId ?? null] as const,
  },

  applications: {
    all: ["applications"] as const,
    /** Bare root for the singular application-detail family — broad-invalidates every `detail(id)` key by prefix. */
    detailAll: ["application"] as const,
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
    // NOTE: TLS *settings* (the ACME/DNS config form) is cached under
    // `queryKeys.settings.tlsSettings` (`["settings","tls"]`), not here —
    // that literal predates this migration and is cross-referenced
    // elsewhere, so don't add a duplicate `tls.settings` key that doesn't
    // match it.
    /**
     * Backing list for `useTlsContainers` (containers eligible for TLS
     * termination). This hook has zero callers anywhere in the app
     * (confirmed dead code as of Phase 4) — the cache-key literal was
     * renamed here from the pre-migration `["tls","containers"]` with no
     * functional risk, since nothing else reads or invalidates it.
     */
    containers: ["tls-certificates"] as const,
  },

  userPreferences: {
    all: ["userPreferences"] as const,
    preferences: ["userPreferences", "preferences"] as const,
    timezones: ["userPreferences", "timezones"] as const,
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
