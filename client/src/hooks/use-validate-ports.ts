import { useQuery } from "@tanstack/react-query";
import {
  HAProxyPortConfig,
  HAProxyPortValidationResult,
} from "@mini-infra/types";

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
  return useQuery({
    queryKey: ["environments", environmentId, "validate-ports"],
    queryFn: () => fetchPortValidation(environmentId!),
    enabled: !!environmentId && (options?.enabled ?? true),
    refetchInterval: options?.refetchInterval ?? 30000, // Poll every 30 seconds by default
    staleTime: 10000, // Consider data stale after 10 seconds
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
