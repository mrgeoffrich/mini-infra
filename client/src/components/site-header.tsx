import { Link, useLocation } from "react-router-dom";
import { Separator } from "@/components/ui/separator";
import { SidebarTrigger } from "@/components/ui/sidebar";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import {
  IconBrandDocker,
  IconCloud,
  IconBrandAzure,
} from "@tabler/icons-react";
import {
  useConnectivityStatus,
  ConnectivityService,
} from "@/hooks/use-settings";

const getPageTitle = (pathname: string): string => {
  switch (pathname) {
    case "/dashboard":
      return "Dashboard";
    case "/containers":
      return "Containers";
    case "/databases":
      return "Databases";
    case "/deployments":
      return "Deployments";
    case "/tunnels":
      return "Cloudflare Tunnels";
    case "/logs":
      return "Activity Logs";
    case "/settings":
    case "/connectivity/overview":
      return "Connectivity";
    case "/connectivity/docker":
      return "Docker Configuration";
    case "/connectivity/cloudflare":
      return "Cloudflare Settings";
    case "/connectivity/azure":
      return "Azure Storage";
    case "/settings/audit":
      return "Audit History";
    case "/user/settings":
      return "User Settings";
    case "/postgres":
      return "PostgreSQL";
    default:
      return "Dashboard";
  }
};

const getSettingsPageTitle = (pathname: string): string => {
  switch (pathname) {
    case "/connectivity/docker":
      return "Docker Configuration";
    case "/connectivity/cloudflare":
      return "Cloudflare Settings";
    case "/connectivity/azure":
      return "Azure Storage";
    case "/settings/audit":
      return "Audit History";
    default:
      return "Settings";
  }
};

// Connectivity status indicator component
function ConnectivityIndicator({
  service,
  icon: Icon,
  label,
}: {
  service: ConnectivityService;
  icon: React.ComponentType<{ size?: number; className?: string }>;
  label: string;
}) {
  const { data: connectivityData } = useConnectivityStatus({
    filters: { service: service },
    limit: 1,
  });

  // Get the most recent status for this service
  const latestStatus = connectivityData?.data?.[0];
  const isConnected = latestStatus?.status === "connected";

  // Map services to their connectivity page routes
  const getConnectivityRoute = (serviceName: string): string => {
    switch (serviceName) {
      case "docker":
        return "/connectivity/docker";
      case "cloudflare":
        return "/connectivity/cloudflare";
      case "azure":
        return "/connectivity/azure";
      default:
        return "/connectivity";
    }
  };

  const content = (
    <div className="flex items-center gap-1.5">
      <Icon size={16} className="text-muted-foreground" />
      <div
        className={`w-2 h-2 rounded-full ${
          isConnected ? "bg-green-500" : "bg-red-500"
        }`}
      />
    </div>
  );

  // If disconnected, make it clickable to go to settings
  if (!isConnected) {
    return (
      <Link
        to={getConnectivityRoute(service)}
        className="flex items-center gap-1.5 hover:opacity-75 cursor-pointer"
        title={`${label}: Disconnected - Click to configure`}
      >
        {content}
      </Link>
    );
  }

  // If connected, just show the status without link
  return (
    <div className="flex items-center gap-1.5" title={`${label}: Connected`}>
      {content}
    </div>
  );
}

export function SiteHeader() {
  const location = useLocation();
  const pageTitle = getPageTitle(location.pathname);
  const isSettingsPage =
    location.pathname.startsWith("/settings") &&
    location.pathname !== "/settings";

  return (
    <header className="flex h-(--header-height) shrink-0 items-center gap-2 border-b transition-[width,height] ease-linear group-has-data-[collapsible=icon]/sidebar-wrapper:h-(--header-height)">
      <div className="flex w-full items-center gap-1 px-4 lg:gap-2 lg:px-6">
        <SidebarTrigger className="-ml-1" />
        <Separator
          orientation="vertical"
          className="mx-2 data-[orientation=vertical]:h-4"
        />
        {isSettingsPage ? (
          <Breadcrumb>
            <BreadcrumbList>
              <BreadcrumbItem>
                <BreadcrumbLink asChild>
                  <Link to="/settings">Settings</Link>
                </BreadcrumbLink>
              </BreadcrumbItem>
              <BreadcrumbSeparator />
              <BreadcrumbItem>
                <BreadcrumbPage>
                  {getSettingsPageTitle(location.pathname)}
                </BreadcrumbPage>
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
        ) : (
          <h1 className="text-base font-medium">{pageTitle}</h1>
        )}

        {/* Connectivity Status Indicators */}
        <div className="ml-auto flex items-center gap-3">
          <ConnectivityIndicator
            service="docker"
            icon={IconBrandDocker}
            label="Docker"
          />
          <ConnectivityIndicator
            service="cloudflare"
            icon={IconCloud}
            label="Cloudflare"
          />
          <ConnectivityIndicator
            service="azure"
            icon={IconBrandAzure}
            label="Azure"
          />
        </div>
      </div>
    </header>
  );
}
