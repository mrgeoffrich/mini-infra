import { useQuery } from "@tanstack/react-query";
import type { StackAdoptionCandidate, StackAdoptionCandidatesResponse } from "@mini-infra/types";

export type { StackAdoptionCandidate as EligibleContainer };

function generateCorrelationId(): string {
  return `eligible-containers-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

async function fetchEligibleContainers(
  environmentId: string,
): Promise<StackAdoptionCandidatesResponse> {
  const correlationId = generateCorrelationId();
  const url = new URL("/api/stacks/eligible-containers", window.location.origin);
  url.searchParams.set("environmentId", environmentId);

  const response = await fetch(url.toString(), {
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Correlation-ID": correlationId,
    },
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(
      errorData.message || `Failed to fetch eligible containers (${response.status})`,
    );
  }

  const data: StackAdoptionCandidatesResponse = await response.json();
  if (!data.success) {
    throw new Error(data.message || "Failed to fetch eligible containers");
  }

  return data;
}

export function useEligibleContainers(environmentId?: string) {
  return useQuery({
    queryKey: ["eligible-containers", environmentId],
    queryFn: () => fetchEligibleContainers(environmentId!),
    enabled: !!environmentId,
    staleTime: 5000,
    gcTime: 30_000,
  });
}
