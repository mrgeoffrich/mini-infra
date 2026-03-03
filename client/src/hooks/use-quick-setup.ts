import { useMutation, useQueryClient } from "@tanstack/react-query";
import { QuickSetupRequest, QuickSetupResponse } from "@mini-infra/types";

// Generate correlation ID for debugging
function generateCorrelationId(): string {
  return `quick-setup-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

// ====================
// Quick Setup API Function
// ====================

async function createAppDatabase(
  request: QuickSetupRequest,
  correlationId: string,
): Promise<QuickSetupResponse> {
  const response = await fetch(
    `/api/postgres-server/workflows/create-app-database`,
    {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        "X-Correlation-ID": correlationId,
      },
      body: JSON.stringify(request),
    },
  );

  if (!response.ok) {
    const errorData = await response.json();
    throw new Error(errorData.message || "Failed to create application database");
  }

  const data: QuickSetupResponse = await response.json();

  if (!data.success) {
    throw new Error(data.message || "Failed to create application database");
  }

  return data;
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
      createAppDatabase({ ...request, serverId }, generateCorrelationId()),
    onSuccess: () => {
      // Invalidate all related queries
      queryClient.invalidateQueries({
        queryKey: ["postgres-servers", serverId, "databases"],
      });
      queryClient.invalidateQueries({
        queryKey: ["postgres-servers", serverId, "users"],
      });
      queryClient.invalidateQueries({
        queryKey: ["postgres-servers", serverId],
      });
      queryClient.invalidateQueries({
        queryKey: ["postgres-grants"],
      });
    },
  });
}
