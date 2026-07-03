import { useMutation } from "@tanstack/react-query";
import { ApiRoute } from "@mini-infra/types";
import type { TestDockerRegistryRequest, TestDockerRegistryResponse } from "@mini-infra/types";
import { apiFetch } from "@/lib/api-client";

export type { TestDockerRegistryRequest, TestDockerRegistryResponse };

// ====================
// System Settings API Functions
// ====================

async function testDockerRegistryConnection(
  request: TestDockerRegistryRequest,
): Promise<TestDockerRegistryResponse> {
  // Raw (non-enveloped) endpoint — `{ success, message, details }` is the
  // body itself, not wrapped in `{ success, data }`.
  return apiFetch<TestDockerRegistryResponse>(
    ApiRoute.settings.systemTestDockerRegistry(),
    {
      method: "POST",
      body: request,
      correlationIdPrefix: "system-settings",
      unwrap: false,
    },
  );
}

// ====================
// System Settings Hooks
// ====================

export function useTestDockerRegistry() {
  return useMutation({
    mutationFn: (request: TestDockerRegistryRequest) =>
      testDockerRegistryConnection(request),
    onError: (error) => {
      console.error("Docker registry test failed:", error);
    },
  });
}
