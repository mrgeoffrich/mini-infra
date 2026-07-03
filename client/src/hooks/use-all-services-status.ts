import { useConnectivityStatus } from "@/hooks/use-settings";
import type { ConnectivityService, ConnectivityStatusInfo } from "@mini-infra/types";

// ====================
// Tri-state connectivity derivation
// ====================
//
// The connected-service dots (Docker/Cloudflare/Storage/GitHub/etc in the
// header) previously collapsed to a boolean: `status === "connected"`. That
// makes "no connectivity row loaded yet" (cold start, before the first
// scheduler check) and "the connectivity-status fetch itself failed"
// visually IDENTICAL to "the service is down" — both rendered as a red dot.
//
// `ConnectivityState` fixes that with a third state: a query that's still
// loading, has errored, or returned no rows yet is "unknown" — genuinely
// "we don't know", never "down". Only a loaded row whose status isn't
// "connected" counts as "down".

export type ConnectivityState = "connected" | "down" | "unknown";

export function deriveConnectivityState(
  latest: ConnectivityStatusInfo | undefined,
  isLoading: boolean,
  isError: boolean,
): ConnectivityState {
  if (isLoading || isError || !latest) {
    return "unknown";
  }
  return latest.status === "connected" ? "connected" : "down";
}

export interface ServiceConnectivityResult {
  state: ConnectivityState;
  latest?: ConnectivityStatusInfo;
  isLoading: boolean;
}

/**
 * Single-service connectivity fan-out with tri-state derivation. The one
 * place that queries `useConnectivityStatus` and maps its result onto
 * {@link ConnectivityState} — every consumer (the header dots, the
 * multi-service aggregates below) goes through this.
 */
export function useServiceConnectivityState(
  service: ConnectivityService,
): ServiceConnectivityResult {
  const { data, isLoading, isError } = useConnectivityStatus({
    filters: { service },
    limit: 1,
  });

  const latest = data?.data?.[0];

  return {
    state: deriveConnectivityState(latest, isLoading, isError),
    latest,
    isLoading,
  };
}

export interface ServicesConnectivity {
  docker: ServiceConnectivityResult;
  cloudflare: ServiceConnectivityResult;
  storage: ServiceConnectivityResult;
  githubApp: ServiceConnectivityResult;
}

/**
 * The shared four-service connectivity fan-out (Docker/Cloudflare/Storage/
 * GitHub App). Replaces the duplicated `useConnectivityStatus` call sites
 * that used to live separately in this hook, in `site-header.tsx`'s
 * `ConnectivityIndicator`, and in `AssistedSetupButton`.
 */
export function useServicesConnectivity(): ServicesConnectivity {
  return {
    docker: useServiceConnectivityState("docker"),
    cloudflare: useServiceConnectivityState("cloudflare"),
    storage: useServiceConnectivityState("storage"),
    githubApp: useServiceConnectivityState("github-app"),
  };
}

// ====================
// Back-compat boolean surface
// ====================

export interface AllServicesStatus {
  isLoading: boolean;
  dockerConnected: boolean;
  cloudflareConnected: boolean;
  storageConnected: boolean;
  githubConnected: boolean;
  anyConnected: boolean;
  allDisconnected: boolean;
}

export function useAllServicesStatus(): AllServicesStatus {
  const { docker, cloudflare, storage, githubApp } = useServicesConnectivity();

  const isLoading =
    docker.isLoading ||
    cloudflare.isLoading ||
    storage.isLoading ||
    githubApp.isLoading;

  const dockerConnected = docker.state === "connected";
  const cloudflareConnected = cloudflare.state === "connected";
  const storageConnected = storage.state === "connected";
  const githubConnected = githubApp.state === "connected";

  const anyConnected =
    dockerConnected ||
    cloudflareConnected ||
    storageConnected ||
    githubConnected;
  const allDisconnected = !anyConnected;

  return {
    isLoading,
    dockerConnected,
    cloudflareConnected,
    storageConnected,
    githubConnected,
    anyConnected,
    allDisconnected,
  };
}
