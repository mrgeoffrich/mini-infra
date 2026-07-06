import { useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { Separator } from "@/components/ui/separator";
import { SidebarTrigger } from "@/components/ui/sidebar";
import {
  IconBrandDocker,
  IconBrandCloudflare,
  IconBrandAzure,
  IconBrandGithub,
  IconBrandGoogleDrive,
  IconDatabase,
  IconHelp,
  IconRobot,
  IconWorld,
  IconX,
} from "@tabler/icons-react";
import { useStorageSettings } from "@/hooks/use-storage-settings";
import { useBackupHealth } from "@/hooks/use-self-backup";
import { useAgentChat } from "@/hooks/use-agent-chat";
import { useServicesConnectivity } from "@/hooks/use-all-services-status";
import { ConnectivityIndicator } from "@/components/connectivity-indicator";
import { Breadcrumbs } from "@/components/breadcrumbs";
import { TaskTrackerPopover } from "@/components/task-tracker/task-tracker-popover";
import { HelpSearchBar } from "@/components/help/HelpSearchBar";
import { useCurrentPageTitle, usePageTitle } from "@/hooks/use-page-title";
import { getHelpDocForRoute } from "@/lib/route-config";


// Backup health indicator component
function BackupHealthIndicator() {
  const { data: healthData } = useBackupHealth({});

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

// Storage connectivity indicator — picks an icon from the active provider so
// the top bar reflects whichever backend (Azure / Drive / generic) is in use.
function StorageConnectivityIndicator() {
  const { data: storageSettings } = useStorageSettings();
  const activeProviderId = storageSettings?.activeProviderId ?? null;

  let icon: React.ComponentType<{ size?: number; className?: string }> =
    IconDatabase;
  if (activeProviderId === "azure") {
    icon = IconBrandAzure;
  } else if (activeProviderId === "google-drive") {
    icon = IconBrandGoogleDrive;
  }

  return (
    <ConnectivityIndicator
      service="storage"
      icon={icon}
      label="Storage"
      tourId="header-storage"
    />
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

  const { docker, cloudflare, storage, githubApp } = useServicesConnectivity();

  // Only a confirmed "down" state should prompt guided setup — a query
  // that's still loading/errored/empty is "unknown", not evidence the
  // service needs configuring.
  const hasDisconnected = [docker, cloudflare, storage, githubApp].some(
    (service) => service.state === "down",
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
          <span className="hidden sm:inline">Guided Setup</span>
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
  const isHelpRoute = location.pathname.startsWith("/help");

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

          {isHelpRoute ? (
            <HelpSearchBar />
          ) : (
            <>
              {location.pathname === '/dashboard' ? (
                <h1 className="text-base font-medium">{pageTitle}</h1>
              ) : (
                <Breadcrumbs />
              )}
            </>
          )}

          {/* Connectivity Status Indicators */}
          <div className="ml-auto flex items-center gap-3">
            {!isHelpRoute && (
              <div className="w-64">
                <HelpSearchBar />
              </div>
            )}
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
              <StorageConnectivityIndicator />

              <ConnectivityIndicator
                service="github-app"
                icon={IconBrandGithub}
                label="GitHub"
                tourId="header-github"
              />
              <ConnectivityIndicator
                service="tailscale"
                icon={IconWorld}
                label="Tailscale"
                tourId="header-tailscale"
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
