import { useQuery } from "@tanstack/react-query";
import { ApiRoute, queryKeys } from "@mini-infra/types";
import type { AddonCatalogResponse } from "@mini-infra/types";
import { apiFetch } from "@/lib/api-client";

async function fetchAddonCatalog(): Promise<AddonCatalogResponse> {
  // Raw response — `{ addons }` has no `{ success, data }` envelope (mirrors
  // the sibling addon-endpoints route).
  return apiFetch<AddonCatalogResponse>(ApiRoute.addons.catalog(), {
    unwrap: false,
    correlationIdPrefix: "addon-catalog",
  });
}

/**
 * Registry-driven Service Addon catalog (`GET /api/addons`). Every registered
 * addon appears here with its applicability (`appliesTo`), connected-service
 * prerequisite (`requiresConnectedService`), attachment `mode`, and the
 * `configFields` descriptor list that drives the per-addon config form.
 *
 * The catalog is effectively static within a session — a new addon only shows
 * up after a server restart registers it — so it's cached generously and never
 * polled. The attach dialog and the Overview "Add-ons" card both read from
 * this one query, so the second consumer is served from cache.
 */
export function useAddonCatalog(enabled: boolean = true) {
  return useQuery({
    queryKey: queryKeys.addons.catalog,
    queryFn: fetchAddonCatalog,
    enabled,
    staleTime: 5 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
  });
}
