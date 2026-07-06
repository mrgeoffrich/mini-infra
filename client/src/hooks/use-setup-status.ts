import { useQuery } from "@tanstack/react-query";
import { ApiRoute, queryKeys } from "@mini-infra/types";
import type { SetupStatusResponse } from "@mini-infra/types";
import { apiFetch } from "@/lib/api-client";

// GET /auth/setup-status returns the raw `{ setupComplete, hasUsers,
// googleOAuthEnabled }` body directly (no `{ success, data }` envelope) —
// same RAW shape as use-version.ts / use-system-info.ts.
async function fetchSetupStatus(): Promise<SetupStatusResponse> {
  return apiFetch<SetupStatusResponse>(ApiRoute.auth.setupStatus(), {
    unwrap: false,
    correlationIdPrefix: "setup-status",
  });
}

export function useSetupStatus() {
  return useQuery({
    queryKey: queryKeys.onboarding.setupStatus,
    queryFn: fetchSetupStatus,
    staleTime: 30 * 1000, // 30 seconds
    retry: 2,
  });
}
