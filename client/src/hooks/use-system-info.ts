import { useQuery } from "@tanstack/react-query";

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
    queryKey: ["app-health"],
    queryFn: async () => {
      const res = await fetch("/health");
      if (!res.ok) throw new Error("Failed to fetch system info");
      return res.json();
    },
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  const info: SystemInfo = {
    forceInsecureOverride: data?.forceInsecureOverride ?? false,
    protocol: typeof window !== "undefined" && window.location.protocol === "https:" ? "https" : "http",
  };

  return info;
}
