import { useQuery } from "@tanstack/react-query";
import type { SetupStatusResponse } from "@mini-infra/types";

async function fetchSetupStatus(): Promise<SetupStatusResponse> {
  const response = await fetch("/auth/setup-status");
  if (!response.ok) {
    throw new Error(`Failed to fetch setup status: ${response.statusText}`);
  }
  return response.json();
}

export function useSetupStatus() {
  return useQuery({
    queryKey: ["setup-status"],
    queryFn: fetchSetupStatus,
    staleTime: 30 * 1000, // 30 seconds
    retry: 2,
  });
}
