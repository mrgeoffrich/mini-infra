import { useMutation } from "@tanstack/react-query";

// Generate correlation ID for debugging
function generateCorrelationId(): string {
  return `system-settings-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

// ====================
// System Settings API Types
// ====================

export interface TestDockerRegistryRequest {
  type: "backup" | "restore";
  image: string;
  registryUsername?: string;
  registryPassword?: string;
}

export interface TestDockerRegistryResponse {
  success: boolean;
  message: string;
  details: {
    image: string;
    authenticated: boolean;
    pullTimeMs?: number;
    errorCode?: string;
  };
}

// ====================
// System Settings API Functions
// ====================

async function testDockerRegistryConnection(
  request: TestDockerRegistryRequest,
  correlationId: string,
): Promise<TestDockerRegistryResponse> {
  const response = await fetch("/api/settings/system/test-docker-registry", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Request-ID": correlationId,
    },
    credentials: "include",
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    // Try to parse error response
    let errorData: TestDockerRegistryResponse;
    try {
      errorData = await response.json();
    } catch {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    
    // If we have structured error data, throw it
    throw new Error(errorData.message);
  }

  return response.json();
}

// ====================
// System Settings Hooks
// ====================

export function useTestDockerRegistry() {
  return useMutation({
    mutationFn: (request: TestDockerRegistryRequest) =>
      testDockerRegistryConnection(request, generateCorrelationId()),
    onError: (error) => {
      console.error("Docker registry test failed:", error);
    },
  });
}