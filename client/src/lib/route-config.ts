import {
  type Icon,
  IconBook,
  IconBrandDocker,
  IconBrandCloudflare,
  IconBrandAzure,
  IconBrandGithub,
  IconCertificate,
  IconDashboard,
  IconDatabase,
  IconKey,
  IconNetwork,
  IconRocket,
  IconServer,
  IconSettings,
  IconShield,
  IconHistory,
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
  },

  "/postgres-server": {
    path: "/postgres-server",
    title: "Postgres Servers",
    icon: IconDatabase,
    showInNav: true,
    navGroup: "main",
    navSection: "databases",
    description: "PostgreSQL server and database management",
    children: {
      detail: {
        path: "/postgres-server/:serverId",
        title: "Server Details",
        breadcrumbLabel: "Server Details",
        parent: "/postgres-server",
        showInNav: false,
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
    children: {
      restore: {
        path: "/postgres-backup/:databaseId/restore",
        title: "Restore Database",
        breadcrumbLabel: "Restore",
        parent: "/postgres-backup",
        showInNav: false,
      },
    },
  },

  "/deployments": {
    path: "/deployments",
    title: "Deployments",
    icon: IconRocket,
    showInNav: true,
    navGroup: "main",
    navSection: "applications",
    description: "Zero-downtime deployment management",
    children: {
      new: {
        path: "/deployments/new",
        title: "New Deployment Configuration",
        breadcrumbLabel: "New Configuration",
        parent: "/deployments",
        showInNav: false,
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
  },

  "/api-keys": {
    path: "/api-keys",
    title: "API Keys",
    icon: IconKey,
    showInNav: true,
    navGroup: "main",
    navSection: "administration",
    description: "API key management",
  },

  "/events": {
    path: "/events",
    title: "Events",
    icon: IconHistory,
    showInNav: true,
    navGroup: "main",
    navSection: "monitoring",
    description: "Track and monitor system operations",
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
    children: {
      frontends: {
        path: "/haproxy/frontends",
        title: "Frontends",
        showInNav: true,
      },
      "frontends/new/manual": {
        path: "/haproxy/frontends/new/manual",
        title: "Connect Container",
        showInNav: false,
      },
      backends: {
        path: "/haproxy/backends",
        title: "Backends",
        showInNav: true,
      },
      "backends/detail": {
        path: "/haproxy/backends/:backendName",
        title: "Backend Details",
        breadcrumbLabel: "Details",
        parent: "/haproxy/backends",
        showInNav: false,
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

  "/connectivity-docker": {
    path: "/connectivity-docker",
    title: "Docker",
    icon: IconBrandDocker,
    showInNav: true,
    navGroup: "main",
    navSection: "connectivity",
    description: "Docker service connectivity and configuration",
  },

  "/connectivity-cloudflare": {
    path: "/connectivity-cloudflare",
    title: "Cloudflare",
    icon: IconBrandCloudflare,
    showInNav: true,
    navGroup: "main",
    navSection: "connectivity",
    description: "Cloudflare service connectivity and configuration",
  },

  "/connectivity-azure": {
    path: "/connectivity-azure",
    title: "Azure Storage",
    icon: IconBrandAzure,
    showInNav: true,
    navGroup: "main",
    navSection: "connectivity",
    description: "Azure Storage service connectivity and configuration",
  },

  "/connectivity-github": {
    path: "/connectivity-github",
    title: "GitHub",
    icon: IconBrandGithub,
    showInNav: true,
    navGroup: "main",
    navSection: "connectivity",
    description: "GitHub App connectivity for packages, repos, and actions",
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
  },

  "/settings-security": {
    path: "/settings-security",
    title: "Security Settings",
    breadcrumbLabel: "Security Settings",
    icon: IconShield,
    showInNav: true,
    navGroup: "main",
    navSection: "administration",
    description: "Security configuration and API keys",
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
  },

  "/settings-github": {
    path: "/settings-github",
    title: "GitHub Settings",
    breadcrumbLabel: "GitHub Settings",
    icon: IconBrandGithub,
    showInNav: true,
    navGroup: "main",
    navSection: "administration",
    description: "GitHub integration for bug reporting",
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
