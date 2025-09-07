import { useMutation, useQuery } from "@tanstack/react-query";

// Types for deployment infrastructure
interface DeployInfrastructureRequest {
  networkName: string;
  networkDriver: "bridge" | "overlay" | "host" | "none";
  traefikImage: string;
  webPort: number;
  dashboardPort: number;
  configYaml: string;
}

interface DeployInfrastructureResponse {
  success: boolean;
  data: {
    network: {
      id: string;
      name: string;
      driver: string;
    };
    traefik: {
      id: string;
      image: string;
      webPort: number;
      dashboardPort: number;
    };
  };
  message: string;
  timestamp: string;
  requestId: string;
}

interface InfrastructureStatusResponse {
  success: boolean;
  data: {
    networkStatus: { exists: boolean; id?: string; error?: string };
    traefikStatus: {
      exists: boolean;
      running: boolean;
      id?: string;
      error?: string;
    };
  };
  message: string;
  timestamp: string;
  requestId: string;
}

interface CleanupInfrastructureRequest {
  networkName: string;
}

// Hook to deploy infrastructure (network + Traefik)
export function useDeployInfrastructure() {
  return useMutation<
    DeployInfrastructureResponse,
    Error,
    DeployInfrastructureRequest
  >({
    mutationFn: async (data: DeployInfrastructureRequest) => {
      const response = await fetch("/api/deployment-infrastructure/deploy", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        credentials: "include",
        body: JSON.stringify(data),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.message || "Failed to deploy infrastructure");
      }

      return response.json();
    },
  });
}

// Hook to get infrastructure status
export function useInfrastructureStatus(networkName: string, enabled = true) {
  return useQuery<InfrastructureStatusResponse, Error>({
    queryKey: ["infrastructure-status", networkName],
    queryFn: async () => {
      const response = await fetch(
        `/api/deployment-infrastructure/status?networkName=${encodeURIComponent(networkName)}`,
        {
          method: "GET",
          headers: {
            "Content-Type": "application/json",
          },
          credentials: "include",
        },
      );

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(
          errorData.message || "Failed to get infrastructure status",
        );
      }

      return response.json();
    },
    enabled: enabled && !!networkName,
    refetchInterval: 5000, // Refresh every 5 seconds to get live status
  });
}

// Hook to cleanup infrastructure
export function useCleanupInfrastructure() {
  return useMutation<
    { success: boolean; message: string },
    Error,
    CleanupInfrastructureRequest
  >({
    mutationFn: async (data: CleanupInfrastructureRequest) => {
      const response = await fetch("/api/deployment-infrastructure/cleanup", {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json",
        },
        credentials: "include",
        body: JSON.stringify(data),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(
          errorData.message || "Failed to cleanup infrastructure",
        );
      }

      return response.json();
    },
  });
}
