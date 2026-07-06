import { useQuery } from "@tanstack/react-query";
import {
  ApiRoute,
  queryKeys,
  type TailscaleIngressStatus,
} from "@mini-infra/types";
import { apiFetch } from "@/lib/api-client";

/**
 * Polls the Tailscale ingress status (tailnet domain, resolved URL, device
 * online) for the Network Access page. Tailnet device status isn't pushed over
 * Socket.IO, so this polls: fast (8s) while waiting for the device to come
 * online after a deploy, then backs off (30s) once it's up. The server caches
 * the underlying tailnet API call for 10s, so the poll stays cheap.
 */
export function useTailscaleIngressStatus(options?: { enabled?: boolean }) {
  return useQuery<TailscaleIngressStatus>({
    queryKey: queryKeys.connectivity.tailscaleIngress,
    queryFn: () =>
      apiFetch<TailscaleIngressStatus>(ApiRoute.connectivity.tailscaleIngress(), {
        unwrap: false,
        correlationIdPrefix: "tailscale-ingress",
      }),
    enabled: options?.enabled ?? true,
    refetchInterval: (query) => (query.state.data?.deviceOnline ? 30_000 : 8_000),
    staleTime: 5_000,
    refetchOnWindowFocus: false,
  });
}
