import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
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

  const query = useQuery<MemoryDiagnostics>({
    queryKey: ["diagnostics", "memory"],
    queryFn: async () => {
      const res = await fetch("/api/diagnostics/memory");
      if (!res.ok) throw new Error(`Failed to load memory diagnostics (${res.status})`);
      return res.json();
    },
    refetchInterval: 5000,
  });

  const smapsQuery = useQuery<SmapsTopResponse>({
    queryKey: ["diagnostics", "smaps-top"],
    queryFn: async () => {
      const res = await fetch("/api/diagnostics/smaps-top?limit=25");
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(text || `Failed to load smaps (${res.status})`);
      }
      return res.json();
    },
    enabled: smapsLoaded,
    refetchInterval: smapsLoaded ? 10000 : false,
  });

  const regionsQuery = useQuery<SmapsRegionsResponse>({
    queryKey: ["diagnostics", "smaps-regions", inspectPathname],
    queryFn: async () => {
      const res = await fetch(
        `/api/diagnostics/smaps-regions?pathname=${encodeURIComponent(inspectPathname)}&limit=10`,
      );
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(text || `Failed to load regions (${res.status})`);
      }
      return res.json();
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
      const res = await fetch("/api/diagnostics/region-peek", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          start: region.start,
          length: Math.min(region.rss, 2 * 1024 * 1024),
          minLen: 8,
          maxStrings: 200,
        }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(text || `Peek failed (${res.status})`);
      }
      const data: PeekResult = await res.json();
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
