import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { ApiRoute, queryKeys } from "@mini-infra/types";
import { apiFetch } from "@/lib/api-client";
import type {
  MemoryDiagnostics,
  SmapsTopResponse,
  SmapsRegionsResponse,
  SmapsRegion,
  PeekResult,
} from "./diagnostics-types";

export function useDiagnostics() {
  const [smapsLoaded, setSmapsLoaded] = useState(false);
  const [inspectPathname, setInspectPathnameState] = useState("[anon]");
  const [inspectPeek, setInspectPeek] = useState<PeekResult | null>(null);
  const [peekingStart, setPeekingStart] = useState<string | null>(null);

  // No diagnostics Socket.IO channel exists at all (server-side memory/heap
  // snapshots aren't pushed) — polling is the only option here, so it's left
  // as-is for all three queries below.
  const query = useQuery<MemoryDiagnostics>({
    queryKey: queryKeys.diagnostics.memory,
    queryFn: () =>
      apiFetch<MemoryDiagnostics>(ApiRoute.diagnostics.memory(), {
        unwrap: false,
        correlationIdPrefix: "diagnostics-memory",
      }),
    refetchInterval: 5000,
  });

  const smapsQuery = useQuery<SmapsTopResponse>({
    queryKey: queryKeys.diagnostics.smapsTop,
    queryFn: () => {
      const url = new URL(ApiRoute.diagnostics.smapsTop(), window.location.origin);
      url.searchParams.set("limit", "25");
      return apiFetch<SmapsTopResponse>(url.toString(), {
        unwrap: false,
        correlationIdPrefix: "diagnostics-smaps-top",
      });
    },
    enabled: smapsLoaded,
    refetchInterval: smapsLoaded ? 10000 : false,
  });

  const regionsQuery = useQuery<SmapsRegionsResponse>({
    queryKey: queryKeys.diagnostics.smapsRegions(inspectPathname),
    queryFn: () => {
      const url = new URL(ApiRoute.diagnostics.smapsRegions(), window.location.origin);
      url.searchParams.set("pathname", inspectPathname);
      url.searchParams.set("limit", "10");
      return apiFetch<SmapsRegionsResponse>(url.toString(), {
        unwrap: false,
        correlationIdPrefix: "diagnostics-smaps-regions",
      });
    },
    enabled: false,
  });

  const setInspectPathname = (pathname: string) => {
    setInspectPathnameState(pathname);
    setInspectPeek(null);
  };

  const loadOrRefreshSmaps = () => {
    if (!smapsLoaded) setSmapsLoaded(true);
    else smapsQuery.refetch();
  };

  const handlePeek = async (region: SmapsRegion) => {
    if (region.rss === 0) {
      toast.error("Region has no resident pages — nothing to peek.");
      return;
    }
    setPeekingStart(region.start);
    setInspectPeek(null);
    try {
      const data = await apiFetch<PeekResult>(ApiRoute.diagnostics.regionPeek(), {
        method: "POST",
        unwrap: false,
        correlationIdPrefix: "diagnostics-region-peek",
        body: {
          start: region.start,
          length: Math.min(region.rss, 2 * 1024 * 1024),
          minLen: 8,
          maxStrings: 200,
        },
      });
      setInspectPeek(data);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to peek region");
    } finally {
      setPeekingStart(null);
    }
  };

  return {
    query,
    smapsQuery,
    regionsQuery,
    smapsLoaded,
    inspectPathname,
    setInspectPathname,
    inspectPeek,
    peekingStart,
    handlePeek,
    loadOrRefreshSmaps,
  };
}
