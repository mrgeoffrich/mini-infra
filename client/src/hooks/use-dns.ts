import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  DnsZonesResponse,
  DnsZoneRecordsResponse,
  DnsRefreshResponse,
  DnsHostnameCheckResult,
} from "@mini-infra/types";

export function useDnsZones() {
  return useQuery<DnsZonesResponse>({
    queryKey: ["dns-zones"],
    queryFn: async () => {
      const response = await fetch("/api/dns/zones", {
        credentials: "include",
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({
          message: "Failed to fetch DNS zones",
        }));
        throw new Error(errorData.message || "Failed to fetch DNS zones");
      }

      return response.json();
    },
    staleTime: 60_000,
    refetchOnReconnect: true,
  });
}

export function useDnsZoneRecords(zoneId: string) {
  return useQuery<DnsZoneRecordsResponse>({
    queryKey: ["dns-zone-records", zoneId],
    queryFn: async () => {
      const response = await fetch(`/api/dns/zones/${zoneId}/records`, {
        credentials: "include",
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({
          message: "Failed to fetch DNS records",
        }));
        throw new Error(errorData.message || "Failed to fetch DNS records");
      }

      return response.json();
    },
    enabled: !!zoneId,
    staleTime: 60_000,
  });
}

export function useRefreshDnsCache() {
  const queryClient = useQueryClient();

  return useMutation<DnsRefreshResponse, Error>({
    mutationFn: async () => {
      const response = await fetch("/api/dns/refresh", {
        method: "POST",
        credentials: "include",
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({
          message: "Failed to refresh DNS cache",
        }));
        throw new Error(errorData.message || "Failed to refresh DNS cache");
      }

      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["dns-zones"] });
      queryClient.invalidateQueries({ queryKey: ["dns-zone-records"] });
    },
  });
}

interface DnsValidateResponse {
  success: boolean;
  data: DnsHostnameCheckResult;
}

export function useDnsValidateHostname(hostname: string) {
  return useQuery<DnsValidateResponse>({
    queryKey: ["dns-validate", hostname],
    queryFn: async () => {
      const response = await fetch(
        `/api/dns/validate/${encodeURIComponent(hostname)}`,
        { credentials: "include" }
      );

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({
          message: "Failed to validate hostname",
        }));
        throw new Error(errorData.message || "Failed to validate hostname");
      }

      return response.json();
    },
    enabled: !!hostname && hostname.includes("."),
    staleTime: 30_000,
  });
}
