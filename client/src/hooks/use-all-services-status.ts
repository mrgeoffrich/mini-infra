import { useConnectivityStatus } from "@/hooks/use-settings";

export function useAllServicesStatus() {
  const { data: dockerData, isLoading: dockerLoading } =
    useConnectivityStatus({
      filters: { service: "docker" },
      limit: 1,
    });
  const { data: cloudflareData, isLoading: cloudflareLoading } =
    useConnectivityStatus({
      filters: { service: "cloudflare" },
      limit: 1,
    });
  const { data: storageData, isLoading: storageLoading } =
    useConnectivityStatus({
      filters: { service: "storage" },
      limit: 1,
    });
  const { data: githubData, isLoading: githubLoading } =
    useConnectivityStatus({
      filters: { service: "github-app" },
      limit: 1,
    });

  const isLoading =
    dockerLoading || cloudflareLoading || storageLoading || githubLoading;

  const dockerConnected = dockerData?.data?.[0]?.status === "connected";
  const cloudflareConnected =
    cloudflareData?.data?.[0]?.status === "connected";
  const storageConnected = storageData?.data?.[0]?.status === "connected";
  const githubConnected = githubData?.data?.[0]?.status === "connected";

  const anyConnected =
    dockerConnected ||
    cloudflareConnected ||
    storageConnected ||
    githubConnected;
  const allDisconnected = !anyConnected;

  return {
    isLoading,
    dockerConnected,
    cloudflareConnected,
    storageConnected,
    githubConnected,
    anyConnected,
    allDisconnected,
  };
}
