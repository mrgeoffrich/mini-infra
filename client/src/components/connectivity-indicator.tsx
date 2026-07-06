import { Link } from "react-router-dom";
import { cn } from "@/lib/utils";
import type { ConnectivityService } from "@mini-infra/types";
import {
  useServiceConnectivityState,
  type ConnectivityState,
} from "@/hooks/use-all-services-status";

// Maps services to their connectivity settings pages.
const CONNECTIVITY_ROUTES: Partial<Record<ConnectivityService, string>> = {
  docker: "/connectivity-docker",
  cloudflare: "/connectivity-cloudflare",
  storage: "/connectivity-storage",
  "github-app": "/connectivity-github",
  tailscale: "/connectivity-tailscale",
};

function getConnectivityRoute(service: ConnectivityService): string {
  return CONNECTIVITY_ROUTES[service] ?? "/dashboard";
}

// Tri-state dot styling: green (connected) / red (down) / grey-pulsing
// (unknown — still loading, errored, or no row yet). Unknown deliberately
// does NOT reuse the red "down" look — see docs/planning/not-shipped/
// frontend-backend-contract-plan.md Phase 7.
const DOT_CLASS: Record<ConnectivityState, string> = {
  connected: "bg-green-500",
  down: "bg-red-500",
  unknown: "bg-gray-400 animate-pulse",
};

const STATE_LABEL: Record<ConnectivityState, string> = {
  connected: "Connected",
  down: "Disconnected - Click to configure",
  unknown: "Checking…",
};

export interface ConnectivityIndicatorProps {
  service: ConnectivityService;
  icon: React.ComponentType<{ size?: number; className?: string }>;
  label: string;
  tourId?: string;
}

/**
 * A single connected-service dot in the header. Tri-state: connected
 * (green), down (red, click-through to the service's connectivity settings
 * page), or unknown (grey, pulsing — the connectivity query hasn't
 * resolved to a real row yet, so we genuinely don't know).
 */
export function ConnectivityIndicator({
  service,
  icon: Icon,
  label,
  tourId,
}: ConnectivityIndicatorProps) {
  const { state } = useServiceConnectivityState(service);

  const title = `${label}: ${STATE_LABEL[state]}`;

  const content = (
    <div className="flex items-center gap-1.5">
      <Icon className="size-4 text-muted-foreground" />
      <div
        className={cn("w-2 h-2 rounded-full", DOT_CLASS[state])}
        data-connectivity-state={state}
      />
    </div>
  );

  // Only the "down" state is click-through — an "unknown" reading isn't
  // grounds to send the user off to reconfigure a service that may well be
  // fine, we just haven't heard back yet.
  if (state === "down") {
    return (
      <Link
        to={getConnectivityRoute(service)}
        className="flex items-center gap-1.5 hover:opacity-75 cursor-pointer"
        title={title}
        aria-label={title}
        {...(tourId ? { "data-tour": tourId } : {})}
      >
        {content}
      </Link>
    );
  }

  return (
    <div
      className="flex items-center gap-1.5"
      title={title}
      aria-label={title}
      {...(tourId ? { "data-tour": tourId } : {})}
    >
      {content}
    </div>
  );
}
