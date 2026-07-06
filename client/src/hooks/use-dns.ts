import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiRoute, queryKeys } from "@mini-infra/types";
import type {
  DnsZonesResponse,
  DnsZoneRecordsResponse,
  DnsRefreshResponse,
  DnsHostnameCheckResult,
  ApiResponse,
} from "@mini-infra/types";
import { apiFetch } from "@/lib/api-client";

// These endpoints return the full `{ success, data }` envelope to the
// caller (page.tsx reads `data?.data?.zones`, `result.data.zonesUpdated`,
// etc.) rather than the unwrapped `data` — so every DNS query/mutation here
// opts out of apiFetch's default unwrapping via `unwrap: false`.

export function useDnsZones() {
  return useQuery<DnsZonesResponse>({
    queryKey: queryKeys.dns.zones,
    queryFn: () =>
      apiFetch<DnsZonesResponse>(ApiRoute.dns.zones(), {
        unwrap: false,
        correlationIdPrefix: "dns-zones",
      }),
    staleTime: 60_000,
    refetchOnReconnect: true,
  });
}

export function useDnsZoneRecords(zoneId: string) {
  return useQuery<DnsZoneRecordsResponse>({
    queryKey: queryKeys.dns.zoneRecords(zoneId),
    queryFn: () =>
      apiFetch<DnsZoneRecordsResponse>(ApiRoute.dns.zoneRecords(zoneId), {
        unwrap: false,
        correlationIdPrefix: "dns-zone-records",
      }),
    enabled: !!zoneId,
    staleTime: 60_000,
  });
}

export function useRefreshDnsCache() {
  const queryClient = useQueryClient();

  return useMutation<DnsRefreshResponse, Error>({
    mutationFn: () =>
      apiFetch<DnsRefreshResponse>(ApiRoute.dns.refresh(), {
        method: "POST",
        unwrap: false,
        correlationIdPrefix: "dns-refresh",
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.dns.zones });
      queryClient.invalidateQueries({ queryKey: queryKeys.dns.zoneRecordsAll });
    },
  });
}

export function useDnsValidateHostname(hostname: string) {
  return useQuery<ApiResponse<DnsHostnameCheckResult>>({
    queryKey: queryKeys.dns.validate(hostname),
    queryFn: () =>
      apiFetch<ApiResponse<DnsHostnameCheckResult>>(
        ApiRoute.dns.validate(encodeURIComponent(hostname)),
        {
          unwrap: false,
          correlationIdPrefix: "dns-validate",
        }
      ),
    enabled: !!hostname && hostname.includes("."),
    staleTime: 30_000,
  });
}
