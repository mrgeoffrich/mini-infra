/**
 * Hooks for the async TLS Certificate Issuance flow.
 *
 * - useStartCertIssuance() — fires the POST mutation, returns operationId
 * - useCertIssuanceProgress() — wraps useOperationProgress for this flow
 */

import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { Channel, ServerEvent, ApiRoute, queryKeys } from "@mini-infra/types";
import type { CreateCertificateRequest, StartCertIssuanceResponse } from "@mini-infra/types";
import { useOperationProgress } from "./use-operation-progress";
import { apiFetch } from "@/lib/api-client";

// ====================
// API Function
// ====================

async function startCertIssuance(
  request: CreateCertificateRequest,
): Promise<StartCertIssuanceResponse> {
  // Enveloped, but the caller (issue-certificate-dialog.tsx) reads
  // result.data.operationId — return the raw envelope rather than unwrapping.
  return apiFetch<StartCertIssuanceResponse>(ApiRoute.tls.certificates(), {
    method: "POST",
    body: request,
    unwrap: false,
    correlationIdPrefix: "cert-issuance",
  });
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

export function useCertIssuanceProgress(operationId: string | null, label?: string) {
  return useOperationProgress({
    channel: Channel.TLS,
    startedEvent: ServerEvent.CERT_ISSUANCE_STARTED,
    stepEvent: ServerEvent.CERT_ISSUANCE_STEP,
    completedEvent: ServerEvent.CERT_ISSUANCE_COMPLETED,
    operationId,
    getOperationId: (p) => p.operationId,
    getTotalSteps: (p) => p.totalSteps,
    getStepNames: (p) => p.stepNames ?? [],
    getStep: (p) => p.step,
    getResult: (p) => ({ success: p.success, steps: p.steps, errors: p.errors }),
    // Spread into a mutable tuple — invalidateKeys is unknown[][], and
    // queryKeys.tls.certificates is a readonly `as const` tuple. Same idiom
    // already used in task-type-registry.ts's "cert-issuance" entry.
    invalidateKeys: [[...queryKeys.tls.certificates]],
    toasts: {
      success: "Certificate issued successfully",
      error: "Certificate issuance failed",
    },
    tracker: {
      type: "cert-issuance",
      label: label ?? "Issuing certificate",
    },
  });
}
