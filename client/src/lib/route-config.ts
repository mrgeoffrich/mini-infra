import {
  type LucideIcon as Icon,
  Container,
  Cloud,
  CloudCog,
  LayoutDashboard,
  Database,
  Key,
  Network,
  Rocket,
  Server,
  Settings,
} from "lucide-react";

export interface RouteMetadata {
  title: string;
  breadcrumbLabel?: string; // Override for breadcrumb display (defaults to title)
  icon?: Icon;
  parent?: string; // Parent route path for breadcrumb hierarchy
  showInNav?: boolean; // Whether to show in sidebar navigation
  navGroup?: 'main' | 'secondary'; // Which navigation group
  description?: string;
}

export interface RouteConfig extends RouteMetadata {
  path: string;
  children?: Record<string, RouteConfig>;
}

// Centralized route configuration with metadata
export const routeConfig: Record<string, RouteConfig> = {
  '/dashboard': {
    path: '/dashboard',
    title: 'Dashboard',
    icon: LayoutDashboard,
    showInNav: true,
    navGroup: 'main',
    description: 'System overview and status'
  },

  '/containers': {
    path: '/containers',
    title: 'Containers',
    icon: Container,
    showInNav: true,
    navGroup: 'main',
    description: 'Docker container management'
  },

  '/postgres': {
    path: '/postgres',
    title: 'PostgreSQL',
    icon: Database,
    showInNav: true,
    navGroup: 'main',
    description: 'Database management and backups',
    children: {
      'restore': {
        path: '/postgres/:databaseId/restore',
        title: 'Restore Database',
        breadcrumbLabel: 'Restore',
        parent: '/postgres',
        showInNav: false
      }
    }
  },

  '/deployments': {
    path: '/deployments',
    title: 'Deployments',
    icon: Rocket,
    showInNav: true,
    navGroup: 'main',
    description: 'Zero-downtime deployment management',
    children: {
      'new': {
        path: '/deployments/new',
        title: 'New Deployment Configuration',
        breadcrumbLabel: 'New Configuration',
        parent: '/deployments',
        showInNav: false
      }
    }
  },

  '/environments': {
    path: '/environments',
    title: 'Environments',
    icon: Server,
    showInNav: true,
    navGroup: 'main',
    description: 'Environment configuration management',
    children: {
      'detail': {
        path: '/environments/:id',
        title: 'Environment Details',
        breadcrumbLabel: 'Details',
        parent: '/environments',
        showInNav: false
      }
    }
  },

  '/tunnels': {
    path: '/tunnels',
    title: 'Cloudflare Tunnels',
    icon: Cloud,
    showInNav: true,
    navGroup: 'main',
    description: 'Cloudflare tunnel monitoring'
  },

  '/api-keys': {
    path: '/api-keys',
    title: 'API Keys',
    icon: Key,
    showInNav: true,
    navGroup: 'main',
    description: 'API key management'
  },

  '/connectivity': {
    path: '/connectivity',
    title: 'Connectivity',
    icon: Network,
    showInNav: true,
    navGroup: 'main',
    description: 'Service connectivity and configuration',
    children: {
      'overview': {
        path: '/connectivity/overview',
        title: 'Connectivity Overview',
        breadcrumbLabel: 'Overview',
        parent: '/connectivity',
        showInNav: false
      },
      'docker': {
        path: '/connectivity/docker',
        title: 'Docker Configuration',
        breadcrumbLabel: 'Docker',
        icon: Container,
        parent: '/connectivity',
        showInNav: true
      },
      'cloudflare': {
        path: '/connectivity/cloudflare',
        title: 'Cloudflare Settings',
        breadcrumbLabel: 'Cloudflare',
        icon: CloudCog,
        parent: '/connectivity',
        showInNav: true
      },
      'azure': {
        path: '/connectivity/azure',
        title: 'Azure Storage',
        breadcrumbLabel: 'Azure',
        icon: Cloud,
        parent: '/connectivity',
        showInNav: true
      }
    }
  },

  '/settings': {
    path: '/settings',
    title: 'Settings',
    icon: Settings,
    showInNav: false,
    navGroup: 'secondary',
    children: {
      'system': {
        path: '/settings/system',
        title: 'System Settings',
        breadcrumbLabel: 'System',
        icon: Settings,
        parent: '/settings',
        showInNav: true,
        navGroup: 'secondary'
      },
      'registry-credentials': {
        path: '/settings/registry-credentials',
        title: 'Registry Credentials',
        breadcrumbLabel: 'Registry Credentials',
        icon: Key,
        parent: '/settings',
        showInNav: true,
        navGroup: 'secondary'
      },
      'self-backup': {
        path: '/settings/self-backup',
        title: 'Self-Backup',
        breadcrumbLabel: 'Self-Backup',
        icon: Database,
        parent: '/settings',
        showInNav: true,
        navGroup: 'secondary'
      }
    }
  },

  '/user': {
    path: '/user',
    title: 'User',
    showInNav: false,
    children: {
      'settings': {
        path: '/user/settings',
        title: 'User Settings',
        breadcrumbLabel: 'Settings',
        parent: '/user',
        showInNav: false
      }
    }
  }
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

// Function overloads for different navigation groups
export function getNavigationItems(group: 'main'): Array<{
  title: string;
  url: string;
  icon?: Icon;
  items?: Array<{
    title: string;
    url: string;
    icon?: Icon;
  }>;
}>;

export function getNavigationItems(group: 'secondary'): Array<{
  title: string;
  url: string;
  icon: Icon;
}>;

export function getNavigationItems(group: 'main' | 'secondary' = 'main') {
  if (group === 'main') {
    // Main navigation allows optional icons
    const items: Array<{
      title: string;
      url: string;
      icon?: Icon;
      items?: Array<{
        title: string;
        url: string;
        icon?: Icon;
      }>;
    }> = [];

    for (const config of Object.values(routeConfig)) {
      if (config.showInNav && config.navGroup === group) {
        const item = {
          title: config.title,
          url: config.path,
          icon: config.icon,
          items: config.children ?
            Object.values(config.children)
              .filter(child => child.showInNav)
              .map(child => ({
                title: child.breadcrumbLabel || child.title,
                url: child.path,
                icon: child.icon
              }))
            : undefined
        };

        items.push(item);
      }
    }

    return items;
  } else {
    // Secondary navigation requires icons
    const items: Array<{
      title: string;
      url: string;
      icon: Icon;
    }> = [];

    for (const config of Object.values(routeConfig)) {
      if (config.showInNav && config.navGroup === group && config.icon) {
        items.push({
          title: config.title,
          url: config.path,
          icon: config.icon
        });
      }

      // Also check children
      if (config.children) {
        for (const child of Object.values(config.children)) {
          if (child.showInNav && child.navGroup === group && child.icon) {
            items.push({
              title: child.breadcrumbLabel || child.title,
              url: child.path,
              icon: child.icon
            });
          }
        }
      }
    }

    return items;
  }
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
      isCurrentPage: path === pathname
    });
  };

  buildChain(currentRoute, pathname);

  return breadcrumbs;
}

// Simple path matching for dynamic routes
function matchPath(pattern: string, pathname: string): boolean {
  // Convert pattern like "/environments/:id" to regex
  const regexPattern = pattern
    .replace(/:[^/]+/g, '[^/]+') // Replace :param with [^/]+
    .replace(/\//g, '\\/'); // Escape forward slashes

  const regex = new RegExp(`^${regexPattern}$`);
  return regex.test(pathname);
}