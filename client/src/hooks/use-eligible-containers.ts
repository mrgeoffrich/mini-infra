import { useQuery } from "@tanstack/react-query";
import { ApiRoute, queryKeys } from "@mini-infra/types";
import type { StackAdoptionCandidate, StackAdoptionCandidatesResponse } from "@mini-infra/types";
import { apiFetch } from "@/lib/api-client";

export type { StackAdoptionCandidate as EligibleContainer };

async function fetchEligibleContainers(
  environmentId: string,
): Promise<StackAdoptionCandidatesResponse> {
  const url = new URL(ApiRoute.stacks.eligibleContainers(), window.location.origin);
  url.searchParams.set("environmentId", environmentId);

  // Enveloped — kept as-is; consumed as `.data` externally
  // (applications/adopt/page.tsx).
  const data = await apiFetch<StackAdoptionCandidatesResponse>(url.toString(), {
    unwrap: false,
    correlationIdPrefix: "eligible-containers",
  });
  if (!data.success) {
    throw new Error(data.message || "Failed to fetch eligible containers");
  }
  return data;
}

export function useEligibleContainers(environmentId?: string) {
  return useQuery({
    queryKey: queryKeys.stacks.eligibleContainers(environmentId),
    queryFn: () => fetchEligibleContainers(environmentId!),
    enabled: !!environmentId,
    staleTime: 5000,
    gcTime: 30_000,
  });
}
