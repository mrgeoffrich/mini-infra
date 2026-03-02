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
  const { data: azureData, isLoading: azureLoading } = useConnectivityStatus({
    filters: { service: "azure" },
    limit: 1,
  });
  const { data: githubData, isLoading: githubLoading } =
    useConnectivityStatus({
      filters: { service: "github-app" },
      limit: 1,
    });

  const isLoading =
    dockerLoading || cloudflareLoading || azureLoading || githubLoading;

  const dockerConnected = dockerData?.data?.[0]?.status === "connected";
  const cloudflareConnected =
    cloudflareData?.data?.[0]?.status === "connected";
  const azureConnected = azureData?.data?.[0]?.status === "connected";
  const githubConnected = githubData?.data?.[0]?.status === "connected";

  const anyConnected =
    dockerConnected || cloudflareConnected || azureConnected || githubConnected;
  const allDisconnected = !anyConnected;

  return {
    isLoading,
    dockerConnected,
    cloudflareConnected,
    azureConnected,
    githubConnected,
    anyConnected,
    allDisconnected,
  };
}
