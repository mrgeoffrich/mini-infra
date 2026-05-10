import { useQuery } from "@tanstack/react-query";
import type { TailscaleAddonEndpointsResponse } from "@mini-infra/types";

async function fetchAddonEndpoints(
  stackId: string,
): Promise<TailscaleAddonEndpointsResponse> {
  const response = await fetch(`/api/stacks/${stackId}/addon-endpoints`, {
    credentials: "include",
    headers: { "Content-Type": "application/json" },
  });
  if (!response.ok) {
    throw new Error(
      `Failed to fetch addon endpoints: ${response.statusText}`,
    );
  }
  return (await response.json()) as TailscaleAddonEndpointsResponse;
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
    queryKey: ["stack-addon-endpoints", stackId],
    queryFn: () => fetchAddonEndpoints(stackId as string),
    enabled: enabled && !!stackId,
  });
}
