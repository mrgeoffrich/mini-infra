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
// - `ApiRoute` — parameterized path builders grouped by resource. Only the
//   `containers` group is fully built out (Phase 2's reference
//   implementation, mirrored by `client/src/hooks/useContainers.ts` and
//   `server/src/routes/containers.ts`); Phase 4 grows this per-resource as it
//   migrates each client hook off inline URL literals. Follow the
//   `containers` shape when adding a new group.
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
 * Parameterized path builders, grouped by resource. `containers` is fully
 * built out as the Phase 2 reference — every endpoint in
 * `server/src/routes/containers.ts` has a matching builder here, and both
 * that router and `client/src/hooks/useContainers.ts` source their paths
 * from it. Add new groups here as later phases migrate more resources.
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
} as const;

export { ALL_API_ROUTES, type ApiRouteEntry } from "./api-routes.generated";
