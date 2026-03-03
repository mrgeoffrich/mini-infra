import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { getRouteMetadata } from '@/lib/route-config';

const DEFAULT_TITLE = 'Mini Infra';
const TITLE_SEPARATOR = ' | ';

/**
 * Hook to automatically manage page titles based on current route
 * Updates document.title when the route changes
 */
export function usePageTitle(customTitle?: string) {
  const location = useLocation();

  useEffect(() => {
    let title = DEFAULT_TITLE;

    if (customTitle) {
      // Use custom title if provided
      title = `${customTitle}${TITLE_SEPARATOR}${DEFAULT_TITLE}`;
    } else {
      // Get title from route configuration
      const routeMetadata = getRouteMetadata(location.pathname);
      if (routeMetadata) {
        title = `${routeMetadata.title}${TITLE_SEPARATOR}${DEFAULT_TITLE}`;
      }
    }

    document.title = title;
  }, [location.pathname, customTitle]);
}

/**
 * Hook to get the current page title without setting document.title
 * Useful for components that need to display the current page title
 */
export function useCurrentPageTitle(): string {
  const location = useLocation();
  const routeMetadata = getRouteMetadata(location.pathname);
  return routeMetadata?.title || 'Unknown Page';
}

/**
 * Hook to get current page metadata
 * Returns full metadata object for the current route
 */
export function useCurrentPageMetadata() {
  const location = useLocation();
  return getRouteMetadata(location.pathname);
}