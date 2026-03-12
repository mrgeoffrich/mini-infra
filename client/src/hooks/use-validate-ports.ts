import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  HAProxyPortConfig,
  HAProxyPortValidationResult,
  Channel,
  ServerEvent,
} from "@mini-infra/types";
import { useSocket, useSocketChannel, useSocketEvent } from "./use-socket";

// ====================
// Types
// ====================

export interface PortValidationResponse {
  success: boolean;
  data: {
    config?: HAProxyPortConfig;
    validation: HAProxyPortValidationResult;
  };
  error?: string;
  message?: string;
}

// ====================
// API Functions
// ====================

async function fetchPortValidation(
  environmentId: string
): Promise<PortValidationResponse> {
  const response = await fetch(`/api/environments/${environmentId}/validate-ports`, {
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to validate ports: ${response.statusText}`);
  }

  return await response.json();
}

// ====================
// Hooks
// ====================

/**
 * Hook to validate HAProxy ports for an environment
 * Polls the validation endpoint to check if ports are available
 *
 * @param environmentId The environment ID to validate ports for
 * @param options Query options
 * @returns Query result with port validation data
 */
export function useValidatePorts(
  environmentId: string | undefined,
  options?: {
    enabled?: boolean;
    refetchInterval?: number | false;
  }
) {
  const queryClient = useQueryClient();
  const { connected } = useSocket();
  const isEnabled = !!environmentId && (options?.enabled ?? true);

  useSocketChannel(Channel.CONTAINERS, isEnabled);

  useSocketEvent(
    ServerEvent.CONTAINERS_LIST,
    () => {
      queryClient.invalidateQueries({ queryKey: ["environments", environmentId, "validate-ports"] });
    },
    isEnabled,
  );

  const refetchInterval =
    options?.refetchInterval ?? (connected ? false : 30000);

  return useQuery({
    queryKey: ["environments", environmentId, "validate-ports"],
    queryFn: () => fetchPortValidation(environmentId!),
    enabled: isEnabled,
    refetchInterval,
    staleTime: 10000,
    refetchOnReconnect: true,
  });
}

/**
 * Helper function to check if any ports are unavailable
 */
export function hasUnavailablePorts(
  validation: HAProxyPortValidationResult | undefined
): boolean {
  if (!validation) return false;
  return !validation.isValid && validation.unavailablePorts.length > 0;
}

/**
 * Helper function to format unavailable ports as a user-friendly string
 */
export function formatUnavailablePorts(
  validation: HAProxyPortValidationResult | undefined
): string {
  if (!validation || validation.unavailablePorts.length === 0) {
    return "";
  }

  return validation.unavailablePorts
    .map((p) => `${p.name} (port ${p.port})`)
    .join(", ");
}
