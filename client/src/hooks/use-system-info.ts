import { useQuery } from "@tanstack/react-query";
import { ApiRoute, queryKeys } from "@mini-infra/types";
import { apiFetch } from "@/lib/api-client";

interface HealthResponse {
  status: string;
  version: string;
  forceInsecureOverride?: boolean;
}

export interface SystemInfo {
  forceInsecureOverride: boolean;
  protocol: "http" | "https";
}

export function useSystemInfo() {
  const { data } = useQuery<HealthResponse>({
    queryKey: queryKeys.appHealth.all,
    queryFn: () =>
      apiFetch<HealthResponse>(ApiRoute.health(), {
        unwrap: false,
        correlationIdPrefix: "app-health",
      }),
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  const info: SystemInfo = {
    forceInsecureOverride: data?.forceInsecureOverride ?? false,
    protocol:
      typeof window !== "undefined" && window.location.protocol === "https:"
        ? "https"
        : "http",
  };

  return info;
}
