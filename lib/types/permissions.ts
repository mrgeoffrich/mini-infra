// ====================
// API Key Permission Types
// ====================

/** Permission scope format: "domain:action" or "*" for full access */
export type PermissionScope = string;

/** All available permission domains */
export type PermissionDomain =
  | "containers"
  | "docker"
  | "deployments"
  | "environments"
  | "haproxy"
  | "postgres"
  | "tls"
  | "settings"
  | "events"
  | "api-keys"
  | "user"
  | "agent"
  | "backups"
  | "registry";

/** Permission actions */
export type PermissionAction = "read" | "write" | "use";

/** Permission definition for UI rendering */
export interface PermissionDefinition {
  scope: PermissionScope;
  domain: PermissionDomain;
  action: PermissionAction;
  label: string;
  description: string;
}

/** Permission group for UI rendering (domain-grouped) */
export interface PermissionGroup {
  domain: PermissionDomain;
  label: string;
  description: string;
  permissions: PermissionDefinition[];
}

/** Preset template definition */
export interface PermissionPreset {
  id: string;
  name: string;
  description: string;
  permissions: PermissionScope[];
}

/** DB-backed permission preset record */
export interface PermissionPresetRecord {
  id: string;
  name: string;
  description: string;
  permissions: PermissionScope[];
  createdAt: string;
  updatedAt: string;
}

export interface CreatePermissionPresetRequest {
  name: string;
  description: string;
  permissions: PermissionScope[];
}

export interface UpdatePermissionPresetRequest {
  name?: string;
  description?: string;
  permissions?: PermissionScope[];
}

// ====================
// Permission Definitions
// ====================

export const PERMISSION_GROUPS: PermissionGroup[] = [
  {
    domain: "containers",
    label: "Containers",
    description: "Docker container management",
    permissions: [
      {
        scope: "containers:read",
        domain: "containers",
        action: "read",
        label: "View Containers",
        description:
          "List and view containers, logs, environment variables, cache stats",
      },
      {
        scope: "containers:write",
        domain: "containers",
        action: "write",
        label: "Manage Containers",
        description:
          "Start, stop, restart, remove containers, flush cache",
      },
    ],
  },
  {
    domain: "docker",
    label: "Docker Resources",
    description: "Docker networks and volumes",
    permissions: [
      {
        scope: "docker:read",
        domain: "docker",
        action: "read",
        label: "View Docker Resources",
        description: "List networks, volumes, inspect volumes",
      },
      {
        scope: "docker:write",
        domain: "docker",
        action: "write",
        label: "Manage Docker Resources",
        description: "Remove networks and volumes",
      },
    ],
  },
  {
    domain: "deployments",
    label: "Deployments",
    description: "Zero-downtime deployment management",
    permissions: [
      {
        scope: "deployments:read",
        domain: "deployments",
        action: "read",
        label: "View Deployments",
        description:
          "View deployment configs, history, DNS, infrastructure status",
      },
      {
        scope: "deployments:write",
        domain: "deployments",
        action: "write",
        label: "Manage Deployments",
        description:
          "Create, update, delete configs, trigger deployments, manage DNS and infrastructure",
      },
    ],
  },
  {
    domain: "environments",
    label: "Environments",
    description: "Environment and service management",
    permissions: [
      {
        scope: "environments:read",
        domain: "environments",
        action: "read",
        label: "View Environments",
        description: "View environments, services, networks, volumes",
      },
      {
        scope: "environments:write",
        domain: "environments",
        action: "write",
        label: "Manage Environments",
        description:
          "Create, update, delete environments, services, networks, volumes",
      },
    ],
  },
  {
    domain: "haproxy",
    label: "Load Balancer",
    description: "HAProxy frontend and backend management",
    permissions: [
      {
        scope: "haproxy:read",
        domain: "haproxy",
        action: "read",
        label: "View Load Balancer",
        description: "View HAProxy frontends, backends, manual frontends",
      },
      {
        scope: "haproxy:write",
        domain: "haproxy",
        action: "write",
        label: "Manage Load Balancer",
        description:
          "Create, update, delete, sync frontends and backends",
      },
    ],
  },
  {
    domain: "postgres",
    label: "PostgreSQL",
    description: "Database management, backups, and server administration",
    permissions: [
      {
        scope: "postgres:read",
        domain: "postgres",
        action: "read",
        label: "View PostgreSQL",
        description:
          "View databases, backup configs, backups, restore ops, servers, users, grants, workflows",
      },
      {
        scope: "postgres:write",
        domain: "postgres",
        action: "write",
        label: "Manage PostgreSQL",
        description:
          "Create, update, delete databases, trigger backups, restore, manage servers, users, grants",
      },
    ],
  },
  {
    domain: "tls",
    label: "TLS Certificates",
    description: "SSL/TLS certificate management",
    permissions: [
      {
        scope: "tls:read",
        domain: "tls",
        action: "read",
        label: "View Certificates",
        description: "View certificates, renewals, TLS settings",
      },
      {
        scope: "tls:write",
        domain: "tls",
        action: "write",
        label: "Manage Certificates",
        description:
          "Issue, renew, delete certificates, update TLS settings",
      },
    ],
  },
  {
    domain: "settings",
    label: "Settings",
    description:
      "System settings, connectivity, and external service configuration",
    permissions: [
      {
        scope: "settings:read",
        domain: "settings",
        action: "read",
        label: "View Settings",
        description:
          "View system settings, connectivity, Azure, Cloudflare, GitHub, Docker host config",
      },
      {
        scope: "settings:write",
        domain: "settings",
        action: "write",
        label: "Manage Settings",
        description:
          "Create, update, delete settings, test connections, validate configurations",
      },
    ],
  },
  {
    domain: "events",
    label: "Events",
    description: "Event tracking and audit logs",
    permissions: [
      {
        scope: "events:read",
        domain: "events",
        action: "read",
        label: "View Events",
        description: "View events and statistics",
      },
      {
        scope: "events:write",
        domain: "events",
        action: "write",
        label: "Manage Events",
        description: "Create, update, delete events, append logs",
      },
    ],
  },
  {
    domain: "api-keys",
    label: "API Keys",
    description: "API key management",
    permissions: [
      {
        scope: "api-keys:read",
        domain: "api-keys",
        action: "read",
        label: "View API Keys",
        description: "List API keys and statistics",
      },
      {
        scope: "api-keys:write",
        domain: "api-keys",
        action: "write",
        label: "Manage API Keys",
        description: "Create, revoke, rotate, delete API keys",
      },
    ],
  },
  {
    domain: "user",
    label: "User Preferences",
    description: "User account and preferences",
    permissions: [
      {
        scope: "user:read",
        domain: "user",
        action: "read",
        label: "View Preferences",
        description: "View user preferences and timezones",
      },
      {
        scope: "user:write",
        domain: "user",
        action: "write",
        label: "Update Preferences",
        description: "Update user preferences",
      },
    ],
  },
  {
    domain: "agent",
    label: "AI Agent",
    description: "AI agent sessions and interactions",
    permissions: [
      {
        scope: "agent:use",
        domain: "agent",
        action: "use",
        label: "Use AI Agent",
        description:
          "Create and manage AI agent sessions, send messages",
      },
    ],
  },
  {
    domain: "backups",
    label: "Self-Backups",
    description: "Mini Infra application backups",
    permissions: [
      {
        scope: "backups:read",
        domain: "backups",
        action: "read",
        label: "View Backups",
        description: "View self-backups and backup settings",
      },
      {
        scope: "backups:write",
        domain: "backups",
        action: "write",
        label: "Manage Backups",
        description:
          "Trigger, delete, restore self-backups, update settings",
      },
    ],
  },
  {
    domain: "registry",
    label: "Registry Credentials",
    description: "Docker registry authentication",
    permissions: [
      {
        scope: "registry:read",
        domain: "registry",
        action: "read",
        label: "View Registry Credentials",
        description: "View Docker registry credentials",
      },
      {
        scope: "registry:write",
        domain: "registry",
        action: "write",
        label: "Manage Registry Credentials",
        description:
          "Create, update, delete, test Docker registry credentials",
      },
    ],
  },
];

/** All available permission scopes */
export const ALL_PERMISSION_SCOPES: PermissionScope[] =
  PERMISSION_GROUPS.flatMap((g) => g.permissions.map((p) => p.scope));

/** All read-only permission scopes */
export const READ_ONLY_SCOPES: PermissionScope[] =
  ALL_PERMISSION_SCOPES.filter((s) => s.endsWith(":read"));

// ====================
// Permission Presets
// ====================

export const PERMISSION_PRESETS: PermissionPreset[] = [
  {
    id: "full-access",
    name: "Full Access",
    description: "Unrestricted access to all API endpoints",
    permissions: ["*"],
  },
  {
    id: "read-only",
    name: "Read Only",
    description: "Read-only access to all data",
    permissions: READ_ONLY_SCOPES,
  },
  {
    id: "ai-agent",
    name: "AI Agent",
    description: "Suitable for AI agent integrations with limited write access",
    permissions: [
      "containers:read",
      "containers:write",
      "docker:read",
      "deployments:read",
      "environments:read",
      "haproxy:read",
      "postgres:read",
      "tls:read",
      "settings:read",
      "events:read",
      "backups:read",
      "registry:read",
      "agent:use",
    ],
  },
  {
    id: "deployment-manager",
    name: "Deployment Manager",
    description: "Deploy and manage applications with full deployment access",
    permissions: [
      "containers:read",
      "containers:write",
      "docker:read",
      "deployments:read",
      "deployments:write",
      "environments:read",
      "environments:write",
      "haproxy:read",
      "haproxy:write",
      "tls:read",
      "tls:write",
      "registry:read",
      "events:read",
      "events:write",
    ],
  },
  {
    id: "database-admin",
    name: "Database Admin",
    description: "Manage PostgreSQL databases and backups",
    permissions: [
      "containers:read",
      "postgres:read",
      "postgres:write",
      "backups:read",
      "backups:write",
      "events:read",
    ],
  },
];

// ====================
// Permission Helpers
// ====================

/** Check if a permissions array grants a specific scope */
export function hasPermission(
  permissions: PermissionScope[] | null,
  requiredScope: PermissionScope,
): boolean {
  // null = full access (backwards compatibility)
  if (permissions === null) return true;
  // Wildcard = full access
  if (permissions.includes("*")) return true;
  // Direct match
  if (permissions.includes(requiredScope)) return true;
  // domain:write implies domain:read
  if (requiredScope.endsWith(":read")) {
    const domain = requiredScope.split(":")[0];
    if (permissions.includes(`${domain}:write`)) return true;
  }
  return false;
}

/** Check if permissions grant any of the required scopes */
export function hasAnyPermission(
  permissions: PermissionScope[] | null,
  requiredScopes: PermissionScope[],
): boolean {
  return requiredScopes.some((scope) => hasPermission(permissions, scope));
}
