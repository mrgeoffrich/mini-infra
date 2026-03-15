import { useQuery } from "@tanstack/react-query";

interface HealthResponse {
  status: string;
  version: string;
}

export function useVersion() {
  const { data } = useQuery<HealthResponse>({
    queryKey: ["app-version"],
    queryFn: async () => {
      const res = await fetch("/health");
      if (!res.ok) throw new Error("Failed to fetch version");
      return res.json();
    },
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });

  return data?.version ?? null;
}
