import { useQuery } from "@tanstack/react-query";
import { ApiRoute, queryKeys } from "@mini-infra/types";
import { apiFetch } from "@/lib/api-client";

interface HealthResponse {
  status: string;
  version: string;
}

export function useVersion() {
  const { data } = useQuery<HealthResponse>({
    queryKey: queryKeys.appVersion.all,
    queryFn: () =>
      apiFetch<HealthResponse>(ApiRoute.health(), {
        unwrap: false,
        correlationIdPrefix: "app-version",
      }),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });

  return data?.version ?? null;
}
