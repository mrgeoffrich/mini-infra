import {
  type Icon,
  IconActivity,
  IconBook,
  IconBrandDocker,
  IconBrandCloudflare,
  IconBrandAzure,
  IconBrandGithub,
  IconCertificate,
  IconDashboard,
  IconDatabase,
  IconKey,
  IconLock,
  IconNetwork,
  IconRobot,
  IconRocket,
  IconServer,
  IconSettings,
  IconShield,
  IconShieldLock,
  IconTemplate,
  IconHistory,
  IconDownload,
  IconUsers,
  IconWorld,
} from "@tabler/icons-react";

export interface RouteMetadata {
  title: string;
  breadcrumbLabel?: string; // Override for breadcrumb display (defaults to title)
  icon?: Icon;
  parent?: string; // Parent route path for breadcrumb hierarchy
  showInNav?: boolean; // Whether to show in sidebar navigation
  navGroup?: "main" | "secondary"; // Which navigation group
  navSection?:
    | "applications"
    | "databases"
    | "networking"
    | "monitoring"
    | "connectivity"
    | "administration"; // Navigation section for grouping
  description?: string;
  helpDoc?: string; // Path to contextual help doc (e.g. "containers/viewing-containers")
}

export interface RouteConfig extends RouteMetadata {
  path: string;
  children?: Record<string, RouteConfig>;
}

// Centralized route configuration with metadata
export const routeConfig: Record<string, RouteConfig> = {
  "/dashboard": {
    path: "/dashboard",
    title: "Dashboard",
    icon: IconDashboard,
    showInNav: true,
    navGroup: "main",
    description: "System overview and status",
    helpDoc: "getting-started/overview",
  },

  "/containers": {
    path: "/containers",
    title: "Containers",
    icon: IconBrandDocker,
    showInNav: true,
    navGroup: "main",
    navSection: "applications",
    description: "Docker container management",
    helpDoc: "containers/viewing-containers",
    children: {
      detail: {
        path: "/containers/:id",
        title: "Container Details",
        breadcrumbLabel: "Details",
        parent: "/containers",
        showInNav: false,
        helpDoc: "containers/managing-containers",
      },
      volumeInspect: {
        path: "/containers/volumes/:name/inspect",
        title: "Volume Inspect",
        breadcrumbLabel: "Inspect",
        parent: "/containers",
        showInNav: false,
        helpDoc: "containers/volume-management",
      },
      volumeFiles: {
        path: "/containers/volumes/:name/files/*",
        title: "Volume File Content",
        breadcrumbLabel: "Files",
        parent: "/containers",
        showInNav: false,
        helpDoc: "containers/volume-management",
      },
    },
  },

  "/postgres-server": {
    path: "/postgres-server",
    title: "Postgres Servers",
    icon: IconDatabase,
    showInNav: true,
    navGroup: "main",
    navSection: "databases",
    description: "PostgreSQL server and database management",
    helpDoc: "postgres-backups/backup-overview",
    children: {
      detail: {
        path: "/postgres-server/:serverId",
        title: "Server Details",
        breadcrumbLabel: "Server Details",
        parent: "/postgres-server",
        showInNav: false,
      },
      database: {
        path: "/postgres-server/:serverId/databases/:dbId",
        title: "Database Details",
        breadcrumbLabel: "Database",
        parent: "/postgres-server",
        showInNav: false,
        helpDoc: "postgres-backups/database-management",
      },
    },
  },

  "/postgres-backup": {
    path: "/postgres-backup",
    title: "Postgres Backups",
    icon: IconDatabase,
    showInNav: true,
    navGroup: "main",
    navSection: "databases",
    description: "Database backups and restore",
    helpDoc: "postgres-backups/backup-overview",
    children: {
      restore: {
        path: "/postgres-backup/:databaseId/restore",
        title: "Restore Database",
        breadcrumbLabel: "Restore",
        parent: "/postgres-backup",
        showInNav: false,
        helpDoc: "postgres-backups/restoring-backups",
      },
    },
  },

  "/applications": {
    path: "/applications",
    title: "Applications",
    icon: IconRocket,
    showInNav: true,
    navGroup: "main",
    navSection: "applications",
    description: "User application management",
    helpDoc: "applications/application-management",
    children: {
      new: {
        path: "/applications/new",
        title: "New Application",
        breadcrumbLabel: "New",
        parent: "/applications",
        showInNav: false,
        helpDoc: "applications/application-management",
      },
      detail: {
        path: "/applications/:id",
        title: "Application Details",
        breadcrumbLabel: "Details",
        parent: "/applications",
        showInNav: false,
        helpDoc: "applications/application-management",
      },
    },
  },

  "/environments": {
    path: "/environments",
    title: "Environments",
    icon: IconServer,
    showInNav: true,
    navGroup: "main",
    navSection: "applications",
    description: "Environment configuration management",
    helpDoc: "environments/environments",
    children: {
      detail: {
        path: "/environments/:id",
        title: "Environment Details",
        breadcrumbLabel: "Details",
        parent: "/environments",
        showInNav: false,
      },
    },
  },

  "/tunnels": {
    path: "/tunnels",
    title: "Cloudflare Tunnels",
    icon: IconBrandCloudflare,
    showInNav: true,
    navGroup: "main",
    navSection: "networking",
    description: "Cloudflare tunnel monitoring",
    helpDoc: "tunnels/tunnel-monitoring",
  },

  "/api-keys": {
    path: "/api-keys",
    title: "API Keys",
    icon: IconKey,
    showInNav: true,
    navGroup: "main",
    navSection: "administration",
    description: "API key management",
    helpDoc: "settings/api-keys",
    children: {
      new: {
        path: "/api-keys/new",
        title: "Create API Key",
        breadcrumbLabel: "New",
        parent: "/api-keys",
        showInNav: false,
      },
      presets: {
        path: "/api-keys/presets",
        title: "Permission Presets",
        breadcrumbLabel: "Presets",
        parent: "/api-keys",
        showInNav: false,
        helpDoc: "settings/permission-presets",
      },
    },
  },

  "/logs": {
    path: "/logs",
    title: "Container Logs",
    icon: IconHistory,
    showInNav: true,
    navGroup: "main",
    navSection: "monitoring",
    description: "Search and browse centralized container logs",
    helpDoc: "monitoring/container-logs",
  },

  "/monitoring": {
    path: "/monitoring",
    title: "Container Metrics",
    icon: IconActivity,
    showInNav: true,
    navGroup: "main",
    navSection: "monitoring",
    description: "Monitor CPU, memory, and network usage across containers",
    helpDoc: "monitoring/container-metrics",
  },

  "/events": {
    path: "/events",
    title: "Events",
    icon: IconHistory,
    showInNav: true,
    navGroup: "main",
    navSection: "monitoring",
    description: "Track and monitor system operations",
    helpDoc: "monitoring/events",
    children: {
      detail: {
        path: "/events/:id",
        title: "Event Details",
        breadcrumbLabel: "Details",
        parent: "/events",
        showInNav: false,
      },
    },
  },

  "/haproxy": {
    path: "/haproxy",
    title: "Load Balancer",
    icon: IconNetwork,
    showInNav: true,
    navGroup: "main",
    navSection: "networking",
    description: "HAProxy frontend management",
    helpDoc: "haproxy/haproxy-overview",
    children: {
      frontends: {
        path: "/haproxy/frontends",
        title: "Frontends",
        parent: "/haproxy",
        showInNav: true,
        helpDoc: "haproxy/haproxy-frontends",
      },
      "frontends/new/manual": {
        path: "/haproxy/frontends/new/manual",
        title: "Connect Container",
        parent: "/haproxy/frontends",
        showInNav: false,
        helpDoc: "haproxy/haproxy-frontends",
      },
      "frontends/detail": {
        path: "/haproxy/frontends/:frontendName",
        title: "Frontend Details",
        breadcrumbLabel: "Details",
        parent: "/haproxy/frontends",
        showInNav: false,
        helpDoc: "haproxy/haproxy-frontends",
      },
      "frontends/edit": {
        path: "/haproxy/frontends/:frontendName/edit",
        title: "Edit Frontend",
        breadcrumbLabel: "Edit",
        parent: "/haproxy/frontends",
        showInNav: false,
        helpDoc: "haproxy/haproxy-frontends",
      },
      backends: {
        path: "/haproxy/backends",
        title: "Backends",
        parent: "/haproxy",
        showInNav: true,
        helpDoc: "haproxy/haproxy-backends",
      },
      "backends/detail": {
        path: "/haproxy/backends/:backendName",
        title: "Backend Details",
        breadcrumbLabel: "Details",
        parent: "/haproxy/backends",
        showInNav: false,
        helpDoc: "haproxy/haproxy-backends",
      },
      instances: {
        path: "/haproxy/instances",
        title: "Instances",
        parent: "/haproxy",
        showInNav: true,
        helpDoc: "haproxy/haproxy-instances",
      },
    },
  },

  "/certificates": {
    path: "/certificates",
    title: "TLS Certificates",
    icon: IconCertificate,
    showInNav: true,
    navGroup: "main",
    navSection: "networking",
    description: "Manage SSL/TLS certificates and renewals",
    helpDoc: "networking/tls-certificates",
    children: {
      detail: {
        path: "/certificates/:id",
        title: "Certificate Details",
        breadcrumbLabel: "Details",
        parent: "/certificates",
        showInNav: false,
      },
    },
  },

  "/egress": {
    path: "/egress",
    title: "Egress",
    icon: IconShield,
    showInNav: true,
    navGroup: "main",
    navSection: "networking",
    description: "Outbound traffic control across all environments",
    helpDoc: "settings/egress-fw-agent",
  },

  "/dns": {
    path: "/dns",
    title: "DNS Zones",
    icon: IconWorld,
    showInNav: true,
    navGroup: "main",
    navSection: "networking",
    description: "View cached DNS zones and records from Cloudflare",
    helpDoc: "networking/dns-zones",
  },

  "/connectivity-docker": {
    path: "/connectivity-docker",
    title: "Docker",
    icon: IconBrandDocker,
    showInNav: true,
    navGroup: "main",
    navSection: "connectivity",
    description: "Docker service connectivity and configuration",
    helpDoc: "connectivity/health-monitoring",
  },

  "/connectivity-cloudflare": {
    path: "/connectivity-cloudflare",
    title: "Cloudflare",
    icon: IconBrandCloudflare,
    showInNav: true,
    navGroup: "main",
    navSection: "connectivity",
    description: "Cloudflare service connectivity and configuration",
    helpDoc: "connectivity/health-monitoring",
  },

  "/connectivity-azure": {
    path: "/connectivity-azure",
    title: "Azure Storage",
    icon: IconBrandAzure,
    showInNav: true,
    navGroup: "main",
    navSection: "connectivity",
    description: "Azure Storage service connectivity and configuration",
    helpDoc: "connectivity/health-monitoring",
  },

  "/connectivity-github": {
    path: "/connectivity-github",
    title: "GitHub",
    icon: IconBrandGithub,
    showInNav: true,
    navGroup: "main",
    navSection: "connectivity",
    description: "GitHub App connectivity for packages, repos, and actions",
    helpDoc: "connectivity/health-monitoring",
  },

  "/settings-system": {
    path: "/settings-system",
    title: "System Settings",
    breadcrumbLabel: "Settings System",
    icon: IconSettings,
    showInNav: true,
    navGroup: "main",
    navSection: "administration",
    description: "System configuration and settings",
    helpDoc: "settings/system-settings",
  },

  "/settings-registry-credentials": {
    path: "/settings-registry-credentials",
    title: "Registry Credentials",
    breadcrumbLabel: "Registry Credentials",
    icon: IconKey,
    showInNav: true,
    navGroup: "main",
    navSection: "administration",
    description: "Docker registry authentication",
    helpDoc: "settings/system-settings",
  },

  "/settings-self-backup": {
    path: "/settings-self-backup",
    title: "Self-Backup Settings",
    breadcrumbLabel: "Self-Backup Settings",
    icon: IconDatabase,
    showInNav: true,
    navGroup: "main",
    navSection: "administration",
    description: "Application backup configuration",
    helpDoc: "postgres-backups/configuring-backups",
  },

  "/settings-tls": {
    path: "/settings-tls",
    title: "TLS Settings",
    breadcrumbLabel: "TLS Settings",
    icon: IconCertificate,
    showInNav: true,
    navGroup: "main",
    navSection: "administration",
    description: "TLS certificate configuration",
    helpDoc: "settings/tls-settings",
  },

  "/settings-ai-assistant": {
    path: "/settings-ai-assistant",
    title: "AI Assistant",
    breadcrumbLabel: "AI Assistant",
    icon: IconRobot,
    showInNav: true,
    navGroup: "main",
    navSection: "administration",
    description: "AI assistant API key, model, and capabilities",
    helpDoc: "settings/ai-assistant",
  },

  "/settings-egress-fw-agent": {
    path: "/settings-egress-fw-agent",
    title: "Egress Firewall Agent",
    breadcrumbLabel: "Egress FW Agent",
    icon: IconShieldLock,
    showInNav: true,
    navGroup: "main",
    navSection: "administration",
    description: "Host-singleton firewall agent that enforces L3/L4 egress rules",
    helpDoc: "settings/egress-fw-agent",
  },

  "/system-diagnostics": {
    path: "/system-diagnostics",
    title: "System Diagnostics",
    breadcrumbLabel: "System Diagnostics",
    icon: IconActivity,
    showInNav: true,
    navGroup: "main",
    navSection: "administration",
    description: "Server process memory and heap diagnostics",
    helpDoc: "settings/system-diagnostics",
  },

  "/settings-self-update": {
    path: "/settings-self-update",
    title: "System Update",
    breadcrumbLabel: "System Update",
    icon: IconDownload,
    showInNav: true,
    navGroup: "main",
    navSection: "administration",
    description: "Update Mini Infra via sidecar container",
    helpDoc: "settings/self-update",
  },

  "/settings-users": {
    path: "/settings-users",
    title: "Users",
    breadcrumbLabel: "Users",
    icon: IconUsers,
    showInNav: true,
    navGroup: "main",
    navSection: "administration",
    description: "User account management",
    helpDoc: "settings/user-management",
  },

  "/settings-authentication": {
    path: "/settings-authentication",
    title: "Authentication",
    breadcrumbLabel: "Authentication",
    icon: IconLock,
    showInNav: true,
    navGroup: "main",
    navSection: "administration",
    description: "Authentication method configuration",
    helpDoc: "settings/authentication",
  },

  "/stack-templates": {
    path: "/stack-templates",
    title: "Stack Templates",
    icon: IconTemplate,
    showInNav: true,
    navGroup: "main",
    navSection: "applications",
    description: "Create and manage reusable stack blueprints",
    helpDoc: "applications/stack-templates",
    children: {
      detail: {
        path: "/stack-templates/:templateId",
        title: "Stack Template",
        breadcrumbLabel: "Details",
        parent: "/stack-templates",
        showInNav: false,
        helpDoc: "applications/stack-templates",
      },
    },
  },

  "/vault": {
    path: "/vault",
    title: "Vault",
    icon: IconShieldLock,
    showInNav: true,
    navGroup: "main",
    navSection: "administration",
    description: "Managed OpenBao secrets vault — bootstrap, policies, AppRoles",
    helpDoc: "vault/vault-overview",
    children: {
      policies: {
        path: "/vault/policies",
        title: "Vault Policies",
        breadcrumbLabel: "Policies",
        parent: "/vault",
        showInNav: false,
        helpDoc: "vault/vault-policies",
      },
      policyDetail: {
        path: "/vault/policies/:id",
        title: "Vault Policy",
        breadcrumbLabel: "Details",
        parent: "/vault/policies",
        showInNav: false,
        helpDoc: "vault/vault-policies",
      },
      approles: {
        path: "/vault/approles",
        title: "Vault AppRoles",
        breadcrumbLabel: "AppRoles",
        parent: "/vault",
        showInNav: false,
        helpDoc: "vault/vault-approles",
      },
      approleDetail: {
        path: "/vault/approles/:id",
        title: "Vault AppRole",
        breadcrumbLabel: "Details",
        parent: "/vault/approles",
        showInNav: false,
        helpDoc: "vault/vault-approles",
      },
    },
  },

  "/bug-report-settings": {
    path: "/bug-report-settings",
    title: "Bug Report Settings",
    breadcrumbLabel: "Bug Report Settings",
    icon: IconBrandGithub,
    showInNav: false,
    description: "GitHub integration for bug reporting",
    helpDoc: "github/github-app-setup",
  },

  "/user": {
    path: "/user",
    title: "User",
    showInNav: false,
    children: {
      settings: {
        path: "/user/settings",
        title: "User Settings",
        breadcrumbLabel: "Settings",
        parent: "/user",
        showInNav: false,
        helpDoc: "settings/user-preferences",
      },
    },
  },

  "/help": {
    path: "/help",
    title: "Documentation",
    icon: IconBook,
    showInNav: false,
    navGroup: "main",
    description: "Guides and reference documentation",
    children: {
      doc: {
        path: "/help/:category/:slug",
        title: "Documentation",
        breadcrumbLabel: "Article",
        parent: "/help",
        showInNav: false,
      },
    },
  },
};

// Helper functions for working with route config
export function getRouteMetadata(pathname: string): RouteMetadata | null {
  // Direct match first
  if (routeConfig[pathname]) {
    return routeConfig[pathname];
  }

  // Check for dynamic routes and nested routes
  for (const [routePath, config] of Object.entries(routeConfig)) {
    // Check children first
    if (config.children) {
      for (const child of Object.values(config.children)) {
        if (matchPath(child.path, pathname)) {
          return child;
        }
      }
    }

    // Then check parent route
    if (matchPath(routePath, pathname)) {
      return config;
    }
  }

  return null;
}

export interface NavSection {
  id: string;
  label: string;
  items: Array<{
    title: string;
    url: string;
    icon?: Icon;
    items?: Array<{
      title: string;
      url: string;
      icon?: Icon;
    }>;
  }>;
}

export type NavPanel = "operations" | "admin";

const panelSections: Record<NavPanel, string[]> = {
  operations: ["applications", "databases", "monitoring"],
  admin: ["connectivity", "networking", "administration"],
};

// Get navigation items grouped by section
export function getNavigationSections(): NavSection[] {
  const sections = new Map<string, NavSection>();

  // Define section order and labels
  const sectionDefinitions: Array<{ id: string; label: string }> = [
    { id: "applications", label: "Applications" },
    { id: "databases", label: "Databases" },
    { id: "networking", label: "Networking" },
    { id: "monitoring", label: "Monitoring" },
    { id: "connectivity", label: "Connected Services" },
    { id: "administration", label: "Administration" },
  ];

  // Initialize sections
  for (const def of sectionDefinitions) {
    sections.set(def.id, {
      id: def.id,
      label: def.label,
      items: [],
    });
  }

  // Group navigation items by section
  for (const config of Object.values(routeConfig)) {
    if (config.showInNav && config.navGroup === "main" && config.navSection) {
      const section = sections.get(config.navSection);
      if (section) {
        const item = {
          title: config.title,
          url: config.path,
          icon: config.icon,
          items: config.children
            ? Object.values(config.children)
                .filter((child) => child.showInNav)
                .map((child) => ({
                  title: child.breadcrumbLabel || child.title,
                  url: child.path,
                  icon: child.icon,
                }))
            : undefined,
        };
        section.items.push(item);
      }
    }

    // Also check children
    if (config.children) {
      for (const child of Object.values(config.children)) {
        if (child.showInNav && child.navGroup === "main" && child.navSection) {
          const section = sections.get(child.navSection);
          if (section) {
            section.items.push({
              title: child.breadcrumbLabel || child.title,
              url: child.path,
              icon: child.icon,
            });
          }
        }
      }
    }
  }

  // Return sections in order, excluding empty sections
  return sectionDefinitions
    .map((def) => sections.get(def.id)!)
    .filter((section) => section.items.length > 0);
}

// Get navigation sections filtered by panel
export function getNavigationSectionsForPanel(panel: NavPanel): NavSection[] {
  const allSections = getNavigationSections();
  const allowedSections = panelSections[panel];
  return allSections.filter((section) => allowedSections.includes(section.id));
}

// Determine which panel a route belongs to based on its navSection
export function getPanelForPath(pathname: string): NavPanel {
  const metadata = getRouteMetadata(pathname);
  // Check the route's own navSection, then walk up via parent
  let current: RouteMetadata | null = metadata;
  while (current) {
    if (current.navSection) {
      for (const [panel, sections] of Object.entries(panelSections)) {
        if (sections.includes(current.navSection)) {
          return panel as NavPanel;
        }
      }
    }
    current = current.parent ? getRouteMetadata(current.parent) : null;
  }

  // Fall back: check if this path is a child of a top-level route with navSection
  if (metadata) {
    for (const [, config] of Object.entries(routeConfig)) {
      if (config.children && config.navSection) {
        for (const child of Object.values(config.children)) {
          if (matchPath(child.path, pathname)) {
            for (const [panel, sections] of Object.entries(panelSections)) {
              if (sections.includes(config.navSection)) {
                return panel as NavPanel;
              }
            }
          }
        }
      }
    }
  }

  return "operations";
}

export function generateBreadcrumbs(pathname: string): Array<{
  title: string;
  href?: string;
  isCurrentPage: boolean;
}> {
  const breadcrumbs: Array<{
    title: string;
    href?: string;
    isCurrentPage: boolean;
  }> = [];

  const currentRoute = getRouteMetadata(pathname);
  if (!currentRoute) {
    return breadcrumbs;
  }

  // Build breadcrumb chain by following parent references
  const buildChain = (route: RouteMetadata, path: string): void => {
    if (route.parent) {
      const parentRoute = getRouteMetadata(route.parent);
      if (parentRoute) {
        buildChain(parentRoute, route.parent);
      }
    }

    breadcrumbs.push({
      title: route.breadcrumbLabel || route.title,
      href: path === pathname ? undefined : path,
      isCurrentPage: path === pathname,
    });
  };

  buildChain(currentRoute, pathname);

  return breadcrumbs;
}

// Get the contextual help doc path for a given route, if one exists
export function getHelpDocForRoute(pathname: string): string | null {
  const metadata = getRouteMetadata(pathname);
  if (metadata?.helpDoc) {
    return `/help/${metadata.helpDoc}`;
  }
  // Walk up to parent if current route doesn't have a helpDoc
  if (metadata?.parent) {
    const parentMetadata = getRouteMetadata(metadata.parent);
    if (parentMetadata?.helpDoc) {
      return `/help/${parentMetadata.helpDoc}`;
    }
  }
  return null;
}

// Simple path matching for dynamic routes
function matchPath(pattern: string, pathname: string): boolean {
  // Convert pattern like "/environments/:id" to regex
  const regexPattern = pattern
    .replace(/:[^/]+/g, "[^/]+") // Replace :param with [^/]+
    .replace(/\//g, "\\/"); // Escape forward slashes

  const regex = new RegExp(`^${regexPattern}$`);
  return regex.test(pathname);
}
