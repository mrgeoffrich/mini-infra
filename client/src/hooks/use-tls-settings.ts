import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

async function fetchTlsSettings(): Promise<Record<string, string>> {
  const response = await fetch("/api/tls/settings", {
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch TLS settings: ${response.statusText}`);
  }

  const data = await response.json();
  return data.data || {};
}

async function updateTlsSettings(
  settings: Record<string, string>
): Promise<void> {
  const response = await fetch("/api/tls/settings", {
    method: "PUT",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(settings),
  });

  if (!response.ok) {
    const errorData = await response.json();
    throw new Error(errorData.error || "Failed to save settings");
  }
}

async function testTlsConnectivity(
  settings: Record<string, string>
): Promise<{ success: boolean; error?: string }> {
  const response = await fetch("/api/tls/connectivity/test", {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(settings),
  });

  if (!response.ok) {
    const errorData = await response.json();
    throw new Error(errorData.error || "Failed to test connection");
  }

  const data = await response.json();
  return data;
}

export function useTlsSettings() {
  return useQuery({
    queryKey: ["settings", "tls"],
    queryFn: fetchTlsSettings,
  });
}

export function useUpdateTlsSettings() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: updateTlsSettings,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["settings", "tls"] });
      toast.success("TLS settings saved successfully");
    },
    onError: (error: Error) => {
      toast.error(error.message || "Failed to save settings");
    },
  });
}

export function useTestTlsConnectivity() {
  return useMutation({
    mutationFn: testTlsConnectivity,
    onSuccess: (data) => {
      if (data.success) {
        toast.success("Connection successful! Azure Key Vault is reachable.");
      } else {
        toast.error(data.error || "Connection failed");
      }
    },
    onError: (error: Error) => {
      toast.error(error.message || "Failed to test connection");
    },
  });
}
