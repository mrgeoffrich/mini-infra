import { useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { Separator } from "@/components/ui/separator";
import { SidebarTrigger } from "@/components/ui/sidebar";
import {
  IconBrandDocker,
  IconBrandCloudflare,
  IconBrandAzure,
  IconBrandGithub,
  IconDatabase,
  IconHelp,
  IconRobot,
  IconX,
} from "@tabler/icons-react";
import {
  useConnectivityStatus,
  ConnectivityService,
} from "@/hooks/use-settings";
import { useBackupHealth } from "@/hooks/use-self-backup";
import { useAgentChat } from "@/hooks/use-agent-chat";
import { Breadcrumbs } from "@/components/breadcrumbs";
import { TaskTrackerPopover } from "@/components/task-tracker/task-tracker-popover";
import { useCurrentPageTitle, usePageTitle } from "@/hooks/use-page-title";
import { getHelpDocForRoute } from "@/lib/route-config";


// Backup health indicator component
function BackupHealthIndicator() {
  const { data: healthData } = useBackupHealth({
    refetchInterval: 60000, // Refresh every minute
  });

  if (!healthData?.health) {
    return null;
  }

  const { status, message } = healthData.health;

  // Determine color and icon based on status
  const getStatusColor = () => {
    switch (status) {
      case "healthy":
        return "bg-green-500";
      case "warning":
        return "bg-yellow-500";
      case "error":
        return "bg-red-500";
      case "not_configured":
        return "bg-gray-400";
      default:
        return "bg-gray-400";
    }
  };

  const content = (
    <div className="flex items-center gap-1.5">
      <IconDatabase className="size-4 text-muted-foreground" />
      <div className={`w-2 h-2 rounded-full ${getStatusColor()}`} />
    </div>
  );

  // If there's an issue, make it clickable
  if (status !== "healthy") {
    return (
      <Link
        to="/settings-self-backup"
        className="flex items-center gap-1.5 hover:opacity-75 cursor-pointer"
        title={`Self-Backup: ${message} - Click to configure`}
        data-tour="header-backup-health"
      >
        {content}
      </Link>
    );
  }

  // If healthy, just show the status without link
  return (
    <div
      className="flex items-center gap-1.5"
      title={`Self-Backup: ${message}`}
      data-tour="header-backup-health"
    >
      {content}
    </div>
  );
}

// Connectivity status indicator component
function ConnectivityIndicator({
  service,
  icon: Icon,
  label,
  tourId,
}: {
  service: ConnectivityService;
  icon: React.ComponentType<{ size?: number; className?: string }>;
  label: string;
  tourId?: string;
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
        return "/connectivity-docker";
      case "cloudflare":
        return "/connectivity-cloudflare";
      case "azure":
        return "/connectivity-azure";
      case "github-app":
        return "/connectivity-github";
      default:
        return "/dashboard";
    }
  };

  const content = (
    <div className="flex items-center gap-1.5">
      <Icon className="size-4 text-muted-foreground" />
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
        {...(tourId ? { "data-tour": tourId } : {})}
      >
        {content}
      </Link>
    );
  }

  // If connected, just show the status without link
  return (
    <div
      className="flex items-center gap-1.5"
      title={`${label}: Connected`}
      {...(tourId ? { "data-tour": tourId } : {})}
    >
      {content}
    </div>
  );
}

// Help button - links to contextual help doc or general help page
function HelpButton() {
  const location = useLocation();
  const isHelpPage = location.pathname.startsWith("/help");

  // Don't show the help button when already on help pages
  if (isHelpPage) {
    return null;
  }

  const contextualHelpPath = getHelpDocForRoute(location.pathname);
  const helpPath = contextualHelpPath ?? "/help";
  const title = contextualHelpPath
    ? "View help for this page"
    : "Documentation";

  return (
    <>
      <Separator
        orientation="vertical"
        className="mx-1 data-[orientation=vertical]:h-4"
      />
      <Link
        to={helpPath}
        className="flex items-center justify-center rounded-md p-1.5 text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
        title={title}
        data-tour="header-help"
      >
        <IconHelp className="size-5" />
      </Link>
    </>
  );
}

// Assisted setup button - appears when AI agent is available and services are disconnected
const ASSISTED_SETUP_DISMISSED_KEY = "assisted-setup-dismissed";

function AssistedSetupButton() {
  const [dismissed, setDismissed] = useState(
    () => sessionStorage.getItem(ASSISTED_SETUP_DISMISSED_KEY) === "true"
  );
  const { agentEnabled, setIsOpen, sendMessage, startNewChat } =
    useAgentChat();

  const { data: dockerData } = useConnectivityStatus({
    filters: { service: "docker" },
    limit: 1,
  });
  const { data: cloudflareData } = useConnectivityStatus({
    filters: { service: "cloudflare" },
    limit: 1,
  });
  const { data: azureData } = useConnectivityStatus({
    filters: { service: "azure" },
    limit: 1,
  });
  const { data: githubData } = useConnectivityStatus({
    filters: { service: "github-app" },
    limit: 1,
  });

  const hasDisconnected = [dockerData, cloudflareData, azureData, githubData].some(
    (data) => data?.data?.[0] && data.data[0].status !== "connected"
  );

  if (dismissed || !agentEnabled || !hasDisconnected) {
    return null;
  }

  const handleClick = () => {
    startNewChat();
    setIsOpen(true);
    sendMessage("Help me set up my disconnected services");
  };

  const handleDismiss = (e: React.MouseEvent) => {
    e.stopPropagation();
    sessionStorage.setItem(ASSISTED_SETUP_DISMISSED_KEY, "true");
    setDismissed(true);
  };

  return (
    <>
      <Separator
        orientation="vertical"
        className="mx-1 data-[orientation=vertical]:h-4"
      />
      <div className="flex items-center" data-tour="header-assisted-setup">
        <button
          onClick={handleClick}
          className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-sm font-medium text-foreground hover:bg-accent transition-colors cursor-pointer"
          title="Open AI assistant to help configure disconnected services"
        >
          <IconRobot className="size-4" />
          <span className="hidden sm:inline">Assisted Setup</span>
        </button>
        <button
          onClick={handleDismiss}
          className="rounded-md p-1 text-muted-foreground hover:text-foreground hover:bg-accent transition-colors cursor-pointer"
          title="Dismiss"
        >
          <IconX className="size-3.5" />
        </button>
      </div>
    </>
  );
}

export function SiteHeader() {
  const location = useLocation();
  const pageTitle = useCurrentPageTitle();

  // Automatically manage document title
  usePageTitle();

  return (
    <header className="flex h-(--header-height) shrink-0 items-center gap-2 border-b transition-[width,height] ease-linear group-has-data-[collapsible=icon]/sidebar-wrapper:h-(--header-height)">
        <div className="flex w-full items-center gap-1 px-4 lg:gap-2 lg:px-6">
          <SidebarTrigger className="-ml-1" />
          <Separator
            orientation="vertical"
            className="mx-2 data-[orientation=vertical]:h-4"
          />

          {location.pathname === '/dashboard' ? (
            <h1 className="text-base font-medium">{pageTitle}</h1>
          ) : (
            <Breadcrumbs />
          )}

          {/* Connectivity Status Indicators */}
          <div className="ml-auto flex items-center gap-3">
            <div className="flex items-center gap-3" data-tour="header-connectivity">
              <ConnectivityIndicator
                service="docker"
                icon={IconBrandDocker}
                label="Docker"
                tourId="header-docker"
              />
              <ConnectivityIndicator
                service="cloudflare"
                icon={IconBrandCloudflare}
                label="Cloudflare"
                tourId="header-cloudflare"
              />
              <ConnectivityIndicator
                service="azure"
                icon={IconBrandAzure}
                label="Azure"
                tourId="header-azure"
              />
              <ConnectivityIndicator
                service="github-app"
                icon={IconBrandGithub}
                label="GitHub"
                tourId="header-github"
              />
            </div>
            <BackupHealthIndicator />
            <TaskTrackerPopover />
            <AssistedSetupButton />
            <HelpButton />
          </div>
        </div>
      </header>
  );
}
