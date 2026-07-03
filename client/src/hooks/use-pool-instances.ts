import { useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Channel, ServerEvent, ApiRoute, queryKeys } from "@mini-infra/types";
import type { PoolInstanceInfo } from "@mini-infra/types";
import { useSocket, useSocketChannel, useSocketEvent } from "./use-socket";
import { apiFetch } from "@/lib/api-client";

async function fetchPoolInstances(
  stackId: string,
  serviceName: string,
): Promise<PoolInstanceInfo[]> {
  // Enveloped `{success, data, message}`; already unwrapped by the original
  // code (`return body.data`), so the default unwrap here is
  // behavior-preserving — downstream consumers (e.g. PoolServiceRow.tsx)
  // already treat the resolved query data as the plain array.
  return apiFetch<PoolInstanceInfo[]>(
    ApiRoute.stacks.poolInstances(stackId, serviceName),
    { correlationIdPrefix: "pool-instances" },
  );
}

/**
 * Fetch the live list of active pool instances for a given (stack, pool)
 * pair. Polling is disabled while the socket is connected — the hook
 * invalidates on every pool:instance:* event so the list stays current.
 */
export function usePoolInstances(stackId: string, serviceName: string, enabled = true) {
  const queryClient = useQueryClient();
  const { connected } = useSocket();

  useSocketChannel(Channel.POOLS, enabled);

  const invalidate = useCallback(
    (payload: { stackId: string; serviceName: string }) => {
      if (payload.stackId !== stackId || payload.serviceName !== serviceName) return;
      queryClient.invalidateQueries({
        queryKey: queryKeys.poolInstances.forService(stackId, serviceName),
      });
    },
    [queryClient, stackId, serviceName],
  );

  useSocketEvent(ServerEvent.POOL_INSTANCE_STARTING, invalidate, enabled);
  useSocketEvent(ServerEvent.POOL_INSTANCE_STARTED, invalidate, enabled);
  useSocketEvent(ServerEvent.POOL_INSTANCE_FAILED, invalidate, enabled);
  useSocketEvent(ServerEvent.POOL_INSTANCE_IDLE_STOPPED, invalidate, enabled);
  useSocketEvent(ServerEvent.POOL_INSTANCE_STOPPED, invalidate, enabled);

  return useQuery({
    queryKey: queryKeys.poolInstances.forService(stackId, serviceName),
    queryFn: () => fetchPoolInstances(stackId, serviceName),
    enabled: enabled && !!stackId && !!serviceName,
    refetchInterval: connected ? false : 5000,
    refetchOnReconnect: true,
    staleTime: 2000,
  });
}

export function useStopPoolInstance() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      stackId,
      serviceName,
      instanceId,
    }: {
      stackId: string;
      serviceName: string;
      instanceId: string;
    }) => {
      return apiFetch(
        ApiRoute.stacks.poolInstance(stackId, serviceName, instanceId),
        { method: "DELETE", correlationIdPrefix: "pool-instances" },
      );
    },
    onSuccess: (_data, vars) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.poolInstances.forService(vars.stackId, vars.serviceName),
      });
    },
  });
}
