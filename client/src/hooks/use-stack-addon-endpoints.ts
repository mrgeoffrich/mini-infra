import { useQuery } from "@tanstack/react-query";
import { ApiRoute, queryKeys } from "@mini-infra/types";
import type { TailscaleAddonEndpointsResponse } from "@mini-infra/types";
import { apiFetch } from "@/lib/api-client";

async function fetchAddonEndpoints(
  stackId: string,
): Promise<TailscaleAddonEndpointsResponse> {
  // Raw response — `{endpoints}` has no `{success, data}` envelope.
  return apiFetch<TailscaleAddonEndpointsResponse>(
    ApiRoute.stacks.addonEndpoints(stackId),
    { unwrap: false, correlationIdPrefix: "stack-addon-endpoints" },
  );
}

/**
 * Server-derived addon endpoint list for a stack. Server-side derivation
 * keeps the `<host>.<tailnet>.ts.net` URL formatting in one place and
 * means the panel doesn't have to know about the addon registry shape.
 *
 * Refetches when the stack snapshot changes (caller passes the version)
 * — there's no socket event for "stack snapshot updated" because the
 * stack-apply pipeline already invalidates the parent stack queries the
 * caller depends on.
 */
export function useStackAddonEndpoints(
  stackId: string | undefined,
  enabled: boolean = true,
) {
  return useQuery({
    queryKey: queryKeys.stacks.addonEndpoints(stackId ?? ""),
    queryFn: () => fetchAddonEndpoints(stackId as string),
    enabled: enabled && !!stackId,
  });
}
