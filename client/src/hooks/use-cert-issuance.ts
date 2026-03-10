/**
 * Hooks for the async TLS Certificate Issuance flow.
 *
 * - useStartCertIssuance() — fires the POST mutation, returns operationId
 * - useCertIssuanceProgress() — wraps useOperationProgress for this flow
 */

import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { Channel, ServerEvent } from "@mini-infra/types";
import { useOperationProgress } from "./use-operation-progress";

// ====================
// API Function
// ====================

interface IssueCertificateRequest {
  domains: string[];
  primaryDomain: string;
  autoRenew?: boolean;
}

interface StartCertIssuanceResponse {
  success: boolean;
  data: {
    started: boolean;
    operationId: string;
  };
}

async function startCertIssuance(
  request: IssueCertificateRequest,
): Promise<StartCertIssuanceResponse> {
  const response = await fetch("/api/tls/certificates", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData.message || "Failed to start certificate issuance");
  }

  return response.json();
}

// ====================
// Hooks
// ====================

export function useStartCertIssuance() {
  return useMutation({
    mutationFn: startCertIssuance,
    onError: (error: Error) => {
      toast.error(error.message);
    },
  });
}

export function useCertIssuanceProgress(operationId: string | null) {
  return useOperationProgress({
    channel: Channel.TLS,
    startedEvent: ServerEvent.CERT_ISSUANCE_STARTED,
    stepEvent: ServerEvent.CERT_ISSUANCE_STEP,
    completedEvent: ServerEvent.CERT_ISSUANCE_COMPLETED,
    operationId,
    getOperationId: (p) => p.operationId,
    getTotalSteps: (p) => p.totalSteps,
    getStep: (p) => p.step,
    getResult: (p) => ({ success: p.success, steps: p.steps, errors: p.errors }),
    invalidateKeys: [["certificates"]],
    toasts: {
      success: "Certificate issued successfully",
      error: "Certificate issuance failed",
    },
  });
}
