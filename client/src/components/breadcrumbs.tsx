import { IconChevronRight, IconHome } from '@tabler/icons-react';
import { Link, useLocation } from 'react-router-dom';
import { generateBreadcrumbs } from '@/lib/route-config';
import { cn } from '@/lib/utils';

interface BreadcrumbsProps {
  className?: string;
  showHome?: boolean;
}

export function Breadcrumbs({ className, showHome = true }: BreadcrumbsProps) {
  const location = useLocation();
  const breadcrumbs = generateBreadcrumbs(location.pathname);

  // Always show something - either breadcrumbs or current page title
  if (breadcrumbs.length === 0) {
    return null;
  }

  return (
    <nav className={cn('flex items-center space-x-1 text-sm text-muted-foreground', className)}>
      {showHome && location.pathname !== '/dashboard' && (
        <>
          <Link
            to="/dashboard"
            className="flex items-center hover:text-foreground transition-colors"
          >
            <IconHome className="size-4" />
            <span className="sr-only">Dashboard</span>
          </Link>
          {breadcrumbs.length > 0 && <IconChevronRight className="size-4" />}
        </>
      )}

      {breadcrumbs.map((breadcrumb, index) => (
        <div key={breadcrumb.title} className="flex items-center">
          {breadcrumb.href ? (
            <Link
              to={breadcrumb.href}
              className="hover:text-foreground transition-colors"
            >
              {breadcrumb.title}
            </Link>
          ) : (
            <span className="text-foreground font-medium">
              {breadcrumb.title}
            </span>
          )}

          {index < breadcrumbs.length - 1 && (
            <IconChevronRight className="size-4 mx-1" />
          )}
        </div>
      ))}
    </nav>
  );
}

/**
 * Compact breadcrumb component for mobile or constrained spaces
 */
export function CompactBreadcrumbs({ className }: { className?: string }) {
  const location = useLocation();
  const breadcrumbs = generateBreadcrumbs(location.pathname);

  // Show only the current page on mobile/compact view
  const currentPage = breadcrumbs.find(b => b.isCurrentPage);

  if (!currentPage) {
    return null;
  }

  return (
    <div className={cn('text-sm font-medium text-foreground', className)}>
      {currentPage.title}
    </div>
  );
}