import { useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Channel, ServerEvent } from "@mini-infra/types";
import type { PoolInstanceInfo } from "@mini-infra/types";
import { useSocket, useSocketChannel, useSocketEvent } from "./use-socket";

interface PoolInstanceListResponse {
  success: boolean;
  data: PoolInstanceInfo[];
  message?: string;
}

async function fetchPoolInstances(
  stackId: string,
  serviceName: string,
): Promise<PoolInstanceInfo[]> {
  const response = await fetch(
    `/api/stacks/${encodeURIComponent(stackId)}/pools/${encodeURIComponent(serviceName)}/instances`,
    { credentials: "include" },
  );
  if (!response.ok) {
    throw new Error(`Failed to fetch pool instances: ${response.statusText}`);
  }
  const body = (await response.json()) as PoolInstanceListResponse;
  if (!body.success) {
    throw new Error(body.message || "Failed to fetch pool instances");
  }
  return body.data;
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
        queryKey: ["pool-instances", stackId, serviceName],
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
    queryKey: ["pool-instances", stackId, serviceName],
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
      const response = await fetch(
        `/api/stacks/${encodeURIComponent(stackId)}/pools/${encodeURIComponent(serviceName)}/instances/${encodeURIComponent(instanceId)}`,
        { method: "DELETE", credentials: "include" },
      );
      if (!response.ok) {
        throw new Error(`Failed to stop pool instance: ${response.statusText}`);
      }
      return response.json();
    },
    onSuccess: (_data, vars) => {
      queryClient.invalidateQueries({
        queryKey: ["pool-instances", vars.stackId, vars.serviceName],
      });
    },
  });
}
