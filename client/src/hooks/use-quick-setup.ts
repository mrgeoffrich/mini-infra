import { useMutation, useQueryClient } from "@tanstack/react-query";
import { QuickSetupRequest, QuickSetupResponse, ApiRoute, queryKeys } from "@mini-infra/types";
import { apiFetch } from "@/lib/api-client";

// ====================
// Quick Setup API Function
// ====================

async function createAppDatabase(
  request: QuickSetupRequest,
): Promise<QuickSetupResponse> {
  return apiFetch<QuickSetupResponse>(ApiRoute.postgresServer.createAppDatabase(), {
    method: "POST",
    body: request,
    correlationIdPrefix: "quick-setup",
    unwrap: false,
  });
}

// ====================
// React Query Hook
// ====================

/**
 * Hook to create a complete application database setup
 * (database + user + grants in one workflow)
 */
export function useQuickSetup(serverId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (request: Omit<QuickSetupRequest, "serverId">) =>
      createAppDatabase({ ...request, serverId }),
    onSuccess: () => {
      // Invalidate all related queries
      queryClient.invalidateQueries({
        queryKey: queryKeys.postgresServer.databasesForServer(serverId),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.postgresServer.usersForServer(serverId),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.postgresServer.detail(serverId),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.postgresServer.grants,
      });
    },
  });
}
